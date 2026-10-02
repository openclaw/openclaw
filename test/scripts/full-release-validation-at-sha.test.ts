import { execFileSync, spawnSync } from "node:child_process";
import {
  chmodSync,
  constants as fsConstants,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { parse as parseYaml } from "yaml";
import {
  assertTrustedWorkflowHarness,
  dispatchInputsDigest,
  parseArgs,
  releaseProfileForTarget,
  releaseDecisionStopsForeground,
  releaseEvidenceVerificationArgs,
  releaseEvidenceVerifierPath,
  resolveRemoteTargetRefSha,
  shouldDeleteTemporaryWorkflowRef,
  tryReadReleaseDecision,
  validateReleaseDecisionPayload,
  verifyTargetRef,
  verifyTrustedWorkflowRef,
} from "../../scripts/full-release-validation-at-sha.mts";
import { resolveTestNodeExecPath } from "../../src/test-utils/node-process.js";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";

const SCRIPT_PATH = resolve("scripts/full-release-validation-at-sha.mjs");
const testNodeExecPath = resolveTestNodeExecPath();
const CURRENT_WORKFLOW_SOURCE = readFileSync(
  ".github/workflows/full-release-validation.yml",
  "utf8",
);
const CONTRACT_ONE_WORKFLOW_SOURCE = CURRENT_WORKFLOW_SOURCE.replace(
  'RELEASE_ISOLATION_TOOLING_CONTRACT: "2"',
  'RELEASE_ISOLATION_TOOLING_CONTRACT: "1"',
).replace('  FULL_RELEASE_SOURCE_ADMISSION_CONTRACT: "1"\n', "");
const LEGACY_WORKFLOW_SOURCE = `name: Full Release Validation
on:
  workflow_dispatch:
    inputs:
      expected_sha:
        required: false
`;

function runGit(cwd: string, args: string[]): string {
  return execFileSync("git", ["-c", "maintenance.auto=false", "-c", "gc.auto=0", ...args], {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  }).trim();
}

type DispatchRepositoryOptions = {
  releaseRef?: string;
  workflowSource?: string;
  targetSource?: Record<string, string>;
  targetAlreadyRemote?: boolean;
};
const repositoryTemplateDirs = useAutoCleanupTempDirTracker(afterAll);
const dispatchRepositoryTemplates = new Map<string, ReturnType<typeof createDispatchRepository>>();
type DispatchWorkflow = { on?: { workflow_dispatch?: { inputs?: Record<string, unknown> } } };
const dispatchWorkflows = new Map<string, DispatchWorkflow>();
const fixtureCleanups: Array<() => void> = [];
afterEach(() => {
  for (const cleanup of fixtureCleanups.splice(0)) {
    cleanup();
  }
});

function createDispatchRepository(root: string, options: DispatchRepositoryOptions = {}) {
  const origin = join(root, "origin.git");
  const checkout = join(root, "checkout");
  const releaseRef = options.releaseRef ?? "release/2026.8.1";
  mkdirSync(checkout);
  execFileSync("git", ["init", "--bare", origin], { stdio: "ignore" });
  execFileSync("git", ["init", "-b", "main"], { cwd: checkout, stdio: "ignore" });
  runGit(checkout, ["config", "user.email", "release-test@openclaw.invalid"]);
  runGit(checkout, ["config", "user.name", "OpenClaw Release Test"]);
  mkdirSync(join(checkout, ".github", "workflows"), { recursive: true });
  mkdirSync(join(checkout, "scripts"), { recursive: true });
  writeFileSync(join(checkout, "package.json"), '{"version":"2026.8.1"}\n');
  writeFileSync(
    join(checkout, "CHANGELOG.md"),
    "## 2026.8.1\n\nRelease notes for the complete selected candidate and its user-facing fixes.\n",
  );
  writeFileSync(
    join(checkout, ".github", "workflows", "full-release-validation.yml"),
    options.workflowSource ?? CURRENT_WORKFLOW_SOURCE,
  );
  writeFileSync(
    join(checkout, "scripts", "release-ci-summary.mjs"),
    `const expected = [
  "--validate-run", "123",
	  "--trusted-workflow-ref", process.env.MOCK_TRUSTED_WORKFLOW_REF,
  "--trusted-workflow-full-ref", process.env.MOCK_TRUSTED_WORKFLOW_FULL_REF,
  "--trusted-workflow-sha", process.env.MOCK_WORKFLOW_SHA,
	  "--json",
  "--verifier-source-sha", process.env.MOCK_WORKFLOW_SHA,
  "--verifier-source-file", process.argv[1],
];
if (JSON.stringify(process.argv.slice(2)) !== JSON.stringify(expected)) {
  console.error("unexpected verifier args: " + JSON.stringify(process.argv.slice(2)));
  process.exit(2);
}
console.log(JSON.stringify({ valid: true, current: { runId: "123" }, root: { runId: "123" }, evidenceReuse: false }));
`,
  );
  runGit(checkout, ["add", "."]);
  runGit(checkout, ["commit", "-m", "test: trusted workflow contract"]);
  const workflowSha = runGit(checkout, ["rev-parse", "HEAD"]);
  const trustedWorkflowTag = `release-publish/${workflowSha.slice(0, 12)}-123`;
  runGit(checkout, ["remote", "add", "origin", origin]);
  runGit(checkout, ["push", "-u", "origin", "main"]);
  runGit(checkout, ["tag", trustedWorkflowTag, workflowSha]);
  runGit(checkout, ["push", "origin", `refs/tags/${trustedWorkflowTag}`]);
  runGit(checkout, ["checkout", "-b", releaseRef]);
  writeFileSync(join(checkout, "target.txt"), "release target\n");
  for (const [relativePath, content] of Object.entries(options.targetSource ?? {})) {
    mkdirSync(join(checkout, relativePath, ".."), { recursive: true });
    writeFileSync(join(checkout, relativePath), content);
  }
  runGit(checkout, ["add", "."]);
  runGit(checkout, ["commit", "-m", "test: release target"]);
  const targetSha = runGit(checkout, ["rev-parse", "HEAD"]);
  if (options.targetAlreadyRemote !== false) {
    runGit(checkout, ["push", "-u", "origin", releaseRef]);
  }
  runGit(checkout, ["checkout", "main"]);

  return { origin, checkout, workflowSha, trustedWorkflowTag, targetSha };
}

function prepareDispatchRepository(root: string, options: DispatchRepositoryOptions) {
  const key = JSON.stringify([
    options.releaseRef ?? "release/2026.8.1",
    options.workflowSource ?? CURRENT_WORKFLOW_SOURCE,
    options.targetSource ?? {},
    options.targetAlreadyRemote !== false,
  ]);
  let template = dispatchRepositoryTemplates.get(key);
  if (!template) {
    template = createDispatchRepository(
      repositoryTemplateDirs.make("openclaw-release-dispatch-template-"),
      options,
    );
    // Copy packed immutable history, while every case retains its own object store.
    runGit(template.origin, ["repack", "-ad"]);
    runGit(template.checkout, ["repack", "-ad"]);
    dispatchRepositoryTemplates.set(key, template);
  }
  const origin = join(root, "origin.git");
  const checkout = join(root, "checkout");
  // Each case can change refs, config and objects without touching the prepared history.
  const copyOptions = { recursive: true, mode: fsConstants.COPYFILE_FICLONE };
  cpSync(template.origin, origin, copyOptions);
  cpSync(template.checkout, checkout, copyOptions);
  runGit(checkout, ["remote", "set-url", "origin", origin]);
  return { ...template, origin, checkout };
}

function createDispatchFixture(
  options: {
    bareShaFetchFailure?: boolean;
    createRefFailure?: boolean;
    deleteRefFailure?: boolean;
    dispatchFailure?: boolean;
    acceptedDispatchFailure?: boolean;
    duplicateOnSecondPage?: boolean;
    runIdentityOverrides?: Record<string, unknown>;
    runPathStyle?: "full-ref";
    witnessInputs?: Record<string, unknown>;
    witnessMissing?: boolean;
    witnessMissingReads?: number;
    witnessDuplicate?: boolean;
    ghRoute?: "path" | "explicit";
    tokenPresent?: boolean;
    artifactMetadata?: Record<string, unknown>;
    exactArtifactMetadata?: Record<string, unknown>;
    artifactReadError?: "metadata" | "archive";
    archiveEscapeFlag?: "required" | "unsupported";
    oversizedArtifactMetadata?: boolean;
    archiveFailure?: "oversized" | "corrupt" | "digest";
    incompletePagination?: boolean;
    dispatchHttpStatus?: number;
    failIntentWrite?: boolean;
    stopBeforeDispatch?: boolean;
    reopenDuringDispatch?: boolean;
    payloadPreparationFailure?: "write";
    payloadCleanupFailure?: boolean;
    parentRunStates?: Array<{
      conclusion: string | null;
      status: string;
      attempt?: number;
      artifactReady?: boolean;
      artifacts?: unknown;
      decisionState?: string;
      decisionAttempt?: number;
    }>;
    runDiscoveryMisses?: number;
    targetAlreadyRemote?: boolean;
    includeTargetRef?: boolean;
    releaseRef?: string;
    workflowSource?: string;
    targetSource?: Record<string, string>;
    omitPurpose?: boolean;
  } = {},
) {
  const root = mkdtempSync(join(tmpdir(), "openclaw-release-dispatch-"));
  const origin = join(root, "origin.git");
  const checkout = join(root, "checkout");
  const binDir = join(root, "bin");
  const gitCallsPath = join(root, "git-calls.jsonl");
  const ghCallsPath = join(root, "gh-calls.jsonl");
  const pathGhCallsPath = join(root, "path-gh-calls.jsonl");
  const parentRunIndexPath = join(root, "parent-run-index.txt");
  const runDiscoveryIndexPath = join(root, "run-discovery-index.txt");
  const witnessReadIndexPath = join(root, "witness-read-index.txt");
  const acceptedRunPath = join(root, "accepted-run.json");
  const artifactFixturePath = join(root, "artifact-fixture.cjs");
  const fetchCallsPath = join(root, "fetch-calls.txt");
  const artifactTransportPath = join(root, "artifact-transport.jsonl");
  const payloadEventsPath = join(root, "payload-events.jsonl");
  const payloadCapturePath = join(root, "payload-capture.json");
  const preloadPath = join(root, "immediate-poll.mjs");
  const waitCallsPath = join(root, "wait-calls.txt");
  const releaseRef = options.releaseRef ?? "release/2026.8.1";
  mkdirSync(binDir);
  writeFileSync(gitCallsPath, "");
  writeFileSync(ghCallsPath, "");
  writeFileSync(pathGhCallsPath, "");
  writeFileSync(parentRunIndexPath, "-2");
  writeFileSync(runDiscoveryIndexPath, "0");
  writeFileSync(waitCallsPath, "");
  writeFileSync(fetchCallsPath, "");
  writeFileSync(artifactTransportPath, "");
  writeFileSync(payloadEventsPath, "");
  writeFileSync(
    preloadPath,
    `import { appendFileSync } from "node:fs";
import fs from "node:fs";
import childProcess from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
import { basename, dirname, join } from "node:path";
const payloadEvent = (stage, path, extra = {}) => appendFileSync(
  ${JSON.stringify(payloadEventsPath)}, JSON.stringify({ stage, path, ...extra }) + "\\n",
);
const isPayloadDirectory = (path) => typeof path === "string" && basename(path).startsWith("openclaw-release-dispatch-payload-");
const makeDirectory = fs.mkdtempSync;
fs.mkdtempSync = (prefix, ...args) => {
  if (!isPayloadDirectory(prefix)) return makeDirectory(prefix, ...args);
  const requests = join(process.cwd(), ".artifacts", "full-release-validation");
  const requestPath = process.env.MOCK_REQUEST_FILE || join(requests, fs.readdirSync(requests).find((name) => name.endsWith(".json")));
  const intent = JSON.parse(fs.readFileSync(requestPath, "utf8"));
  if (intent.phase !== "prepared" || intent.refs.workflow !== "intended") {
    throw new Error("payload preparation requires durable prepared intent before the workflow ref");
  }
  const directory = makeDirectory(prefix, ...args);
  payloadEvent("created", directory);
  return directory;
};
const write = fs.writeFileSync;
fs.writeFileSync = (path, data, ...args) => {
  if (${JSON.stringify(options.failIntentWrite ?? false)} && String(data).includes('"phase":"attempted"')) {
    throw new Error("injected intent write failure");
  }
  if (typeof path === "string" && isPayloadDirectory(dirname(path))) {
    payloadEvent("write", path, { options: args[0] });
    if (${JSON.stringify(options.payloadPreparationFailure ?? "")} === "write") {
      write(path, String(data).slice(0, 10), ...args);
      throw new Error("injected payload write failure");
    }
  }
  return write(path, data, ...args);
};
const remove = fs.rmSync;
fs.rmSync = (path, ...args) => {
  if (!isPayloadDirectory(path)) return remove(path, ...args);
  payloadEvent("cleanup", path);
  if (${JSON.stringify(options.payloadCleanupFailure ?? false)}) {
    throw new Error("private-cleanup-error-must-not-be-logged".repeat(100));
  }
  return remove(path, ...args);
};
const execute = childProcess.execFileSync;
childProcess.execFileSync = (file, args, options) => {
  if (${JSON.stringify(options.stopBeforeDispatch ?? false)} && args?.some((arg) => arg.endsWith("/dispatches"))) {
    process.exit(77);
  }
  if (args?.some((arg) => /\\/actions\\/workflows\\/17\\/runs$/.test(arg))) {
    payloadEvent("reconcile", "");
  }
  if (args?.some((arg) => /\\/actions\\/artifacts\\/\\d+(?:\\/zip)?$/.test(arg))) {
    appendFileSync(${JSON.stringify(artifactTransportPath)}, JSON.stringify({
      args, encoding: options.encoding, timeout: options.timeout, maxBuffer: options.maxBuffer,
    }) + "\\n");
  }
  return execute(file, args, options);
};
syncBuiltinESMExports();
globalThis.fetch = async () => {
  appendFileSync(${JSON.stringify(fetchCallsPath)}, "forbidden Node fetch\\n");
  throw new Error("Node fetch must not bypass the selected GitHub CLI");
};
const wait = Atomics.wait;
const now = Date.now;
let elapsed = 0;
Date.now = () => now() + elapsed;
Atomics.wait = (array, index, value, timeout) => {
  if (timeout === undefined) return wait(array, index, value);
  appendFileSync(process.env.MOCK_WAIT_CALLS, String(timeout) + "\\n");
  elapsed += timeout;
  return "timed-out";
};
`,
  );

  const { workflowSha, trustedWorkflowTag, targetSha } = prepareDispatchRepository(root, options);
  const workflowSource = readFileSync(
    join(checkout, ".github", "workflows", "full-release-validation.yml"),
    "utf8",
  );
  let workflow = dispatchWorkflows.get(workflowSource);
  if (!workflow) {
    workflow = parseYaml(workflowSource) as DispatchWorkflow;
    dispatchWorkflows.set(workflowSource, workflow);
  }
  const declaredWorkflowInputs = Object.keys(workflow.on?.workflow_dispatch?.inputs ?? {});
  writeFileSync(
    artifactFixturePath,
    `const fs = require("node:fs");
const { createHash } = require("node:crypto");
const JSZip = require(${JSON.stringify(createRequire(import.meta.url).resolve("jszip"))});
module.exports = async () => {
  const accepted = JSON.parse(fs.readFileSync(${JSON.stringify(acceptedRunPath)}, "utf8"));
  const inputs = { ...accepted.inputs, ...${JSON.stringify(options.witnessInputs ?? {})} };
  const canonicalInputs = JSON.stringify(Object.fromEntries(
    Object.entries(inputs).filter(([, value]) => String(value) !== "")
      .sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)
      .map(([key, value]) => [key, String(value)]),
  ));
  const witness = {
    kind: "openclaw.full-release-dispatch-inputs/v1",
    serverUrl: "https://github.com",
    repository: "openclaw/openclaw",
    workflowRef: "openclaw/openclaw/.github/workflows/full-release-validation.yml@refs/heads/" + accepted.ref,
    event: "workflow_dispatch",
    ref: "refs/heads/" + accepted.ref,
    sha: process.env.MOCK_WORKFLOW_SHA,
    runId: "123", runAttempt: "1",
    inputsDigest: "sha256:" + createHash("sha256").update(canonicalInputs).digest("hex"),
  };
  const zip = new JSZip();
  zip.file("dispatch-inputs.json", JSON.stringify(witness) + "\\n", { date: new Date("2026-01-01T00:00:00Z") });
  const bytes = ${JSON.stringify(options.archiveFailure ?? "")} === "corrupt"
    ? Buffer.from("not a ZIP archive")
    : await zip.generateAsync({ type: "nodebuffer", compression: "STORE" });
  return {
    bytes,
    metadata: {
      id: 9001, name: "full-release-dispatch-inputs-123-1", expired: false,
      expires_at: "2099-01-01T00:00:00Z", size_in_bytes: bytes.length,
      digest: "sha256:" + createHash("sha256").update(bytes).digest("hex"),
      workflow_run: { id: 123, head_sha: process.env.MOCK_WORKFLOW_SHA },
      ...${JSON.stringify(options.artifactMetadata ?? {})},
    },
  };
};
`,
  );
  const gitPath = join(binDir, "git");
  writeFileSync(
    gitPath,
    `#!${testNodeExecPath}
const fs = require("node:fs");
const { spawnSync } = require("node:child_process");
const args = process.argv.slice(2);
fs.appendFileSync(process.env.MOCK_GIT_CALLS, JSON.stringify(args) + "\\n");
if (args.includes("https://github.com/openclaw/openclaw.git")) {
  if (${JSON.stringify(options.bareShaFetchFailure ?? false)}) {
    console.error("fatal: remote error: upload-pack: not our ref " + args.at(-1));
    process.exit(1);
  }
  process.exit(0);
}
const result = spawnSync("git", args, {
  env: { ...process.env, PATH: process.env.MOCK_REAL_PATH },
  stdio: "inherit",
});
process.exit(result.status ?? 1);
`,
  );
  chmodSync(gitPath, 0o755);

  const ghPath = join(binDir, "gh");
  writeFileSync(
    ghPath,
    `#!${testNodeExecPath}
const fs = require("node:fs");
fs.appendFileSync(process.env.MOCK_PATH_GH_CALLS, JSON.stringify(process.argv.slice(2)) + "\\n");
console.error("PATH gh must not be used");
process.exit(89);
`,
  );
  chmodSync(ghPath, 0o755);

  const selectedGhPath = join(binDir, "selected-gh");
  writeFileSync(
    selectedGhPath,
    `#!${testNodeExecPath}
const fs = require("node:fs");
const { spawnSync } = require("node:child_process");
const args = process.argv.slice(2);
fs.appendFileSync(process.env.MOCK_GH_CALLS, JSON.stringify(args) + "\\n");
if (process.argv[1] === ${JSON.stringify(ghPath)}) {
  fs.appendFileSync(process.env.MOCK_PATH_GH_CALLS, JSON.stringify(args) + "\\n");
}
if (args[0] === "auth" && args[1] === "token") {
  console.error("fixture credentials belong to the selected CLI");
  process.exit(90);
}
const parentRunStates = ${JSON.stringify(options.parentRunStates ?? [{ conclusion: "success", status: "completed" }])};
const parentRunIndexPath = ${JSON.stringify(parentRunIndexPath)};
const runDiscoveryIndexPath = ${JSON.stringify(runDiscoveryIndexPath)};
const acceptedRunPath = ${JSON.stringify(acceptedRunPath)};
const endpoint = args.find((arg) => arg.startsWith("repos/openclaw/openclaw/")) || "";
const methodIndex = args.indexOf("--method");
const method = methodIndex >= 0 ? args[methodIndex + 1] : "GET";
const fields = new Map();
for (let index = 0; index < args.length; index += 1) {
  if (args[index] !== "-f") continue;
  const assignment = args[index + 1] || "";
  const separator = assignment.indexOf("=");
  fields.set(assignment.slice(0, separator), assignment.slice(separator + 1));
  index += 1;
}
const hasNoCache = args.some(
  (arg, index) => ["-H", "--header"].includes(arg) && args[index + 1] === "Cache-Control: max-age=0",
);
const runMetadata = (id, state = parentRunStates[0]) => {
  const accepted = fs.existsSync(acceptedRunPath) ? JSON.parse(fs.readFileSync(acceptedRunPath, "utf8")) : {};
  return {
    ...state, id, head_sha: process.env.MOCK_WORKFLOW_SHA, run_attempt: state.attempt ?? 1,
    workflow_id: 17, head_branch: accepted.ref, event: "workflow_dispatch",
    path: ".github/workflows/full-release-validation.yml" + (
      ${JSON.stringify(options.runPathStyle ?? "bare")} === "full-ref" ? "@refs/heads/" + accepted.ref : ""
    ),
    repository: { full_name: "openclaw/openclaw" },
    head_repository: { full_name: "openclaw/openclaw" },
    display_title: "Full Release Validation",
    html_url: "https://github.com/openclaw/openclaw/actions/runs/" + id,
    ...${JSON.stringify(options.runIdentityOverrides ?? {})},
  };
};
if (args[0] === "api" && method === "GET" && !hasNoCache) {
  console.error("authoritative reads require Cache-Control: max-age=0");
  process.exit(18);
}
if (args[0] === "api" && method === "POST" && endpoint.endsWith("/git/refs")) {
  const ref = fields.get("ref") || "";
  const sha = fields.get("sha") || "";
  if (${JSON.stringify(options.createRefFailure ?? false)}) {
    console.error("configured workflow ref creation failure");
    process.exit(19);
  }
  const object = spawnSync(
    "git",
    ["--git-dir", process.env.MOCK_ORIGIN, "cat-file", "-e", sha + "^{object}"],
    {
      env: { ...process.env, PATH: process.env.MOCK_REAL_PATH },
      stdio: "ignore",
    },
  );
  if (object.status !== 0) {
    console.error("gh: Object does not exist (HTTP 422)");
    process.exit(19);
  }
  const result = spawnSync("git", ["--git-dir", process.env.MOCK_ORIGIN, "update-ref", ref, sha], {
    env: { ...process.env, PATH: process.env.MOCK_REAL_PATH },
    stdio: "inherit",
  });
  process.exit(result.status ?? 1);
} else if (args[0] === "api" && method === "DELETE" && endpoint.includes("/git/refs/")) {
  const ref = "refs/" + endpoint.slice(endpoint.indexOf("/git/refs/") + "/git/refs/".length);
  if (${JSON.stringify(options.deleteRefFailure ?? false)}) {
    console.error("configured workflow ref deletion failure");
    process.exit(20);
  }
  const result = spawnSync("git", ["--git-dir", process.env.MOCK_ORIGIN, "update-ref", "-d", ref], {
    env: { ...process.env, PATH: process.env.MOCK_REAL_PATH },
    stdio: "inherit",
  });
  process.exit(result.status ?? 1);
} else if (method === "POST" && endpoint.endsWith("/dispatches")) {
  const inputIndex = args.indexOf("--input");
  const payloadPath = inputIndex >= 0 ? args[inputIndex + 1] : undefined;
  const payloadText = payloadPath ? fs.readFileSync(payloadPath, "utf8") : undefined;
  const payload = payloadText === undefined ? undefined : JSON.parse(payloadText);
  const wireInputs = payload.inputs;
  if (payload) {
    const directory = require("node:path").dirname(payloadPath);
    fs.writeFileSync(${JSON.stringify(payloadCapturePath)}, JSON.stringify({
      body: payload, path: payloadPath, directory,
      bytes: Buffer.byteLength(payloadText),
      regularFile: fs.lstatSync(payloadPath).isFile(),
      fileMode: fs.statSync(payloadPath).mode & 0o777,
      directoryMode: fs.statSync(directory).mode & 0o777,
    }));
    fs.appendFileSync(${JSON.stringify(payloadEventsPath)}, JSON.stringify({ stage: "post", path: payloadPath }) + "\\n");
  }
  const declaredInputs = new Set(JSON.parse(process.env.MOCK_WORKFLOW_INPUTS));
  for (const key of Object.keys(wireInputs)) {
    if (!declaredInputs.has(key)) {
      console.error("workflow input is not declared: " + key);
      process.exit(2);
    }
  }
  if (args[0] === "api") {
    const directory = require("node:path").join(process.cwd(), ".artifacts", "full-release-validation");
    const requestPath = process.env.MOCK_REQUEST_FILE || require("node:path").join(directory, fs.readdirSync(directory).find((name) => name.endsWith(".json")));
    const intent = JSON.parse(fs.readFileSync(requestPath, "utf8"));
    if (intent.phase !== "attempted" || JSON.stringify(intent.request.wireInputs) !== JSON.stringify(wireInputs) ||
        (payload && payload.ref !== intent.request.workflowRef) ||
        (fs.statSync(requestPath).mode & 0o777) !== 0o600) {
      throw new Error("POST must have an exact private retained attempted intent");
    }
    if (${JSON.stringify(options.reopenDuringDispatch ?? false)}) {
      const before = fs.readFileSync(requestPath, "utf8");
      const second = spawnSync(process.execPath, [${JSON.stringify(SCRIPT_PATH)}, "--request-file", requestPath], {
        encoding: "utf8", env: process.env,
      });
      if (second.status !== 1 || !second.stderr.includes("dispatch=unknown") ||
          fs.readFileSync(requestPath, "utf8") !== before) {
        throw new Error("Concurrent request reopen must remain read-only and unresolved before acceptance");
      }
    }
  }
  if (${JSON.stringify(options.dispatchHttpStatus ?? 204)} !== 204) {
    console.log("HTTP/2.0 " + ${JSON.stringify(options.dispatchHttpStatus ?? 204)} + " Rejected\\r\\nContent-Type: application/json\\r\\n\\r\\n{}");
    process.exit(1);
  }
  if (${JSON.stringify(options.dispatchFailure ?? false)}) {
    console.error("configured workflow dispatch failure");
    process.exit(21);
  }
  fs.writeFileSync(acceptedRunPath, JSON.stringify({
    inputs: wireInputs,
    ref: payload.ref,
  }));
  if (${JSON.stringify(options.acceptedDispatchFailure ?? false)}) {
    console.error("connection reset by peer after server acceptance");
    process.exit(1);
  }
  console.log("HTTP/2.0 204 No Content\\r\\nContent-Length: 0\\r\\n\\r\\n");
} else if (args[0] === "api" && endpoint.endsWith("/actions/workflows/full-release-validation.yml")) {
  console.log(JSON.stringify({ id: 17, path: ".github/workflows/full-release-validation.yml" }));
} else if (args[0] === "api" && /\\/actions\\/workflows\\/(?:17|full-release-validation.yml)\\/runs$/.test(endpoint)) {
  const index = Number(fs.readFileSync(runDiscoveryIndexPath, "utf8"));
  fs.writeFileSync(runDiscoveryIndexPath, String(index + 1));
  const ids = ${JSON.stringify(options.duplicateOnSecondPage ?? false)} ? Array.from({ length: 21 }, (_, i) => 123 + i)
    : [123];
  const runs = index < ${JSON.stringify(options.runDiscoveryMisses ?? 0)} || !fs.existsSync(acceptedRunPath)
    ? []
    : ids.map((id) => runMetadata(id));
  const page = Number(fields.get("page") || "1");
  if (args.includes("--include")) {
    let headers = "HTTP/2.0 200 OK\\r\\nContent-Type: application/json\\r\\n";
    if (runs.length > page * 20 && !${JSON.stringify(options.incompletePagination ?? false)}) {
      const query = new URLSearchParams({ page: String(page + 1), branch: fields.get("branch"), event: "workflow_dispatch", per_page: "20" });
      headers += "Link: <https://api.github.com/repos/openclaw/openclaw/actions/workflows/17/runs?" + query + '>; rel="next"\\r\\n';
    }
    process.stdout.write(headers + "\\r\\n");
  }
  console.log(JSON.stringify({ total_count: runs.length, workflow_runs: runs.slice((page - 1) * 20, page * 20) }));
} else if (args[0] === "api" && endpoint.endsWith("/actions/runs/123")) {
  const index = Number(fs.readFileSync(parentRunIndexPath, "utf8"));
  const state = parentRunStates[Math.max(0, Math.min(index, parentRunStates.length - 1))];
  fs.writeFileSync(parentRunIndexPath, String(index + 1));
  console.log(JSON.stringify(runMetadata(123, state)));
} else if (args[0] === "api" && /\\/actions\\/artifacts\\/9001(?:\\/zip)?$/.test(endpoint)) {
  if (method !== "GET" || args[args.indexOf("--hostname") + 1] !== "github.com" || args.includes("--include")) {
    throw new Error("artifact reads require exact-host GET without response headers");
  }
  const archive = endpoint.endsWith("/zip");
  if (archive && ${JSON.stringify(options.archiveEscapeFlag ?? "")} === "unsupported" && args.includes("--allow-escape-sequences")) {
    console.error("unknown flag: --allow-escape-sequences");
    process.exit(1);
  }
  if (archive && ${JSON.stringify(options.archiveEscapeFlag ?? "")} === "required" && !args.includes("--allow-escape-sequences")) {
    console.error("refusing to output binary content without --allow-escape-sequences");
    process.exit(1);
  }
  if (${JSON.stringify(options.artifactReadError ?? "")} === (archive ? "archive" : "metadata")) {
    console.error("artifact read denied (HTTP 403)");
    process.exit(1);
  }
  require(${JSON.stringify(artifactFixturePath)})().then(({ metadata, bytes }) => {
    if (!archive) {
      console.log(${JSON.stringify(options.oversizedArtifactMetadata ?? false)}
        ? JSON.stringify({ padding: "x".repeat(256 * 1024) })
        : JSON.stringify({ ...metadata, ...${JSON.stringify(options.exactArtifactMetadata ?? {})} }));
      return;
    }
    const failure = ${JSON.stringify(options.archiveFailure ?? "")};
    if (failure === "oversized") bytes = Buffer.alloc(256 * 1024 + 1);
    if (failure === "digest") bytes[0] ^= 1;
    process.stdout.write(bytes);
  });
} else if (args[0] === "api" && endpoint.endsWith("/artifacts") && (fields.get("name") || "").startsWith("full-release-dispatch-inputs-")) {
  require(${JSON.stringify(artifactFixturePath)})().then(({ metadata }) => {
    const witnessReads = fs.existsSync(${JSON.stringify(witnessReadIndexPath)})
      ? Number(fs.readFileSync(${JSON.stringify(witnessReadIndexPath)}, "utf8")) : 0;
    fs.writeFileSync(${JSON.stringify(witnessReadIndexPath)}, String(witnessReads + 1));
    const artifacts = ${JSON.stringify(options.witnessMissing ?? false)} ||
      witnessReads < ${JSON.stringify(options.witnessMissingReads ?? 0)} ? []
      : ${JSON.stringify(options.witnessDuplicate ?? false)} ? [metadata, metadata] : [metadata];
    console.log(JSON.stringify({ total_count: artifacts.length, artifacts }));
  });
} else if (args[0] === "api" && endpoint.endsWith("/artifacts")) {
  const index = Number(fs.readFileSync(parentRunIndexPath, "utf8")) - 1;
  const state = parentRunStates[index];
  console.log(JSON.stringify({ artifacts: state.artifacts ?? (state.artifactReady ? [{
    name: "full-release-decision-123-" + (state.attempt ?? 1), expired: false,
  }] : []) }));
} else if (args[0] === "api" && endpoint.endsWith("/jobs")) {
  console.log(JSON.stringify({ jobs: [{ name: "Diagnostic Drain", status: "in_progress" }] }));
} else if (args[0] === "run" && args[1] === "download") {
  const index = Number(fs.readFileSync(parentRunIndexPath, "utf8")) - 1;
  const state = parentRunStates[index];
  if (state.decisionState) {
    const dir = args[args.indexOf("--dir") + 1];
    fs.writeFileSync(dir + "/full-release-decision.json", JSON.stringify({
      kind: "openclaw.full-release-decision", mode: "decision", version: 2,
      parentRunAttempt: state.decisionAttempt ?? state.attempt ?? 1,
      sourceParentRunAttempt: 1, parentRunId: "123", activeRunIds: ["101"],
      blockers: [{ child: "normalCi", job: "test", runId: "101" }],
      cancellation: { cancelledRunIds: [], requested: false }, children: {}, errors: [],
      executionPlanSha256: "c".repeat(64), releaseProfile: "stable", rerunGroup: "all",
      state: state.decisionState, targetSha: "b".repeat(40), workflowRef: "main",
      workflowSha: process.env.MOCK_WORKFLOW_SHA,
    }));
    process.exit(0);
  }
  console.error(parentRunStates[index]?.status === "queued" ? "no artifact matches any of the names or patterns provided" : "no valid artifacts found");
  process.exit(1);
} else {
  console.error("unexpected gh call: " + args.join(" "));
  process.exit(2);
}
`,
  );
  chmodSync(selectedGhPath, 0o755);
  if (options.ghRoute === "path") {
    writeFileSync(ghPath, readFileSync(selectedGhPath));
  }

  const run = (extraArgs: string[] = [], recoveryOnly = false) => {
    const trustedRefIndex = extraArgs.indexOf("--trusted-workflow-ref");
    const trustedWorkflowRef =
      trustedRefIndex >= 0 ? (extraArgs[trustedRefIndex + 1] ?? "") : "main";
    const trustedWorkflowFullRef =
      trustedWorkflowRef === "main" ? "refs/heads/main" : `refs/tags/${trustedWorkflowRef}`;
    const githubEnv = { ...process.env };
    for (const key of Object.keys(githubEnv)) {
      if (/^(?:GH|GITHUB)_.*TOKEN$/u.test(key) || key === "OPENCLAW_GH_BIN") {
        delete githubEnv[key];
      }
    }
    if (options.tokenPresent !== false) {
      githubEnv.GH_TOKEN = "fixture-token";
    }
    if (options.ghRoute !== "path") {
      githubEnv.OPENCLAW_GH_BIN = selectedGhPath;
    }
    return spawnSync(
      testNodeExecPath,
      [
        SCRIPT_PATH,
        ...(!recoveryOnly &&
        !options.omitPurpose &&
        !extraArgs.some((arg) => arg.startsWith("validation_purpose="))
          ? ["-f", "validation_purpose=diagnostic"]
          : []),
        ...(recoveryOnly
          ? []
          : [
              "--sha",
              targetSha,
              "--workflow-sha",
              workflowSha,
              ...(options.includeTargetRef === false ? [] : ["--target-ref", releaseRef]),
            ]),
        ...extraArgs,
      ],
      {
        cwd: checkout,
        encoding: "utf8",
        env: {
          ...githubEnv,
          NODE_OPTIONS: [process.env.NODE_OPTIONS, "--import", preloadPath]
            .filter(Boolean)
            .join(" "),
          MOCK_GH_CALLS: ghCallsPath,
          MOCK_GIT_CALLS: gitCallsPath,
          MOCK_ORIGIN: origin,
          MOCK_PATH_GH_CALLS: pathGhCallsPath,
          MOCK_REAL_PATH: process.env.PATH,
          MOCK_TRUSTED_WORKFLOW_FULL_REF: trustedWorkflowFullRef,
          MOCK_TRUSTED_WORKFLOW_REF: trustedWorkflowRef,
          MOCK_WAIT_CALLS: waitCallsPath,
          MOCK_WORKFLOW_INPUTS: JSON.stringify(declaredWorkflowInputs),
          MOCK_REQUEST_FILE: extraArgs.includes("--request-file")
            ? extraArgs[extraArgs.indexOf("--request-file") + 1]
            : "",
          MOCK_WORKFLOW_SHA: workflowSha,
          PATH: `${binDir}:${process.env.PATH}`,
        },
      },
    );
  };
  const readCalls = (path: string): string[][] =>
    readFileSync(path, "utf8")
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as string[]);
  const readWaits = (): number[] =>
    readFileSync(waitCallsPath, "utf8").trim().split("\n").filter(Boolean).map(Number);
  const readPayloadEvents = (): Array<{
    stage: string;
    path: string;
    options?: { flag: string; mode: number };
  }> =>
    readFileSync(payloadEventsPath, "utf8")
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line));

  const requestPath = () => {
    const directory = join(checkout, ".artifacts", "full-release-validation");
    return join(
      directory,
      readdirSync(directory).find((name) => name.endsWith(".json"))!,
    );
  };
  const calls = (method?: string) =>
    readCalls(ghCallsPath).filter((args) => !method || ghApiMethod(args) === method);
  const refs = () =>
    runGit(origin, [
      "for-each-ref",
      "--format=%(refname)",
      "refs/heads/release-ci",
      "refs/heads/validation",
    ])
      .split("\n")
      .filter(Boolean);
  fixtureCleanups.push(() => {
    for (const event of readPayloadEvents().filter((entry) => entry.stage === "created")) {
      rmSync(event.path, { force: true, recursive: true });
    }
    rmSync(root, { force: true, recursive: true });
  });
  return {
    checkout,
    acceptedRunPath,
    artifactTransportPath,
    ghCallsPath,
    fetchCallsPath,
    gitCallsPath,
    origin,
    pathGhCallsPath,
    readCalls,
    readWaits,
    readPayloadEvents,
    readPayload: () =>
      JSON.parse(readFileSync(payloadCapturePath, "utf8")) as {
        body: { ref: string; inputs: Record<string, string> };
        path: string;
        directory: string;
        bytes: number;
        regularFile: boolean;
        fileMode: number;
        directoryMode: number;
      },
    requestPath,
    record: () => JSON.parse(readFileSync(requestPath(), "utf8")),
    calls,
    refs,
    dispatches: () => calls().filter(isWorkflowDispatch),
    gitCalls: () => readCalls(gitCallsPath),
    releaseRef,
    run,
    selectedGhPath,
    targetSha,
    trustedWorkflowTag,
    workflowSha,
  };
}

function ghApiEndpoint(args: string[]): string {
  return args.find((arg) => arg.startsWith("repos/openclaw/openclaw/")) ?? "";
}

function ghApiMethod(args: string[]): string {
  const index = args.indexOf("--method");
  return index >= 0 ? (args[index + 1] ?? "") : "GET";
}

function isWorkflowDispatch(args: string[]) {
  return (
    (args[0] === "workflow" && args[1] === "run") ||
    (ghApiMethod(args) === "POST" && ghApiEndpoint(args).endsWith("/dispatches"))
  );
}

function ghField(args: string[], name: string): string {
  const prefix = `${name}=`;
  return (
    args
      .find((arg, index) => args[index - 1] === "-f" && arg.startsWith(prefix))
      ?.slice(prefix.length) ?? ""
  );
}

describe("full-release-validation-at-sha", () => {
  it("rejects a missing purpose before remote creation on supporting tooling", () => {
    const fixture = createDispatchFixture({ omitPurpose: true });
    const result = fixture.run();
    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/validation_purpose/u);
    expect(fixture.calls("POST")).toEqual([]);
  });

  it("retains publication and lane inputs in the envelope and reopens the same request read-only", () => {
    const fixture = createDispatchFixture();
    const excluded = ["extensions/example/src/example.test.ts"];
    const excludedJson = JSON.stringify(excluded, null, 1);
    const selection = JSON.stringify(
      {
        route: "normal",
        npmDistTag: "latest",
        publishOpenclawNpm: true,
        plugins: [],
        pluginPublishScope: "all-publishable",
      },
      null,
      1,
    );
    const result = fixture.run([
      "-f",
      "validation_purpose=publish",
      "-f",
      `publication_selection_json=${selection}`,
      "-f",
      `extension_test_exclude_patterns_json=${excludedJson}`,
    ]);
    expect(result.status, result.stderr).toBe(0);
    const record = fixture.record();
    const wire = record.request.wireInputs.trusted_workflow_json;
    expect(JSON.parse(wire)).toEqual({
      trustedWorkflow: {
        ref: "main",
        fullRef: "refs/heads/main",
        sha: fixture.workflowSha,
      },
      validationPurpose: "publish",
      publicationSelection: JSON.parse(selection),
      laneInputs: {
        extension_test_exclude_patterns_json: JSON.stringify(excluded),
      },
    });
    expect(record.request.inputs.trusted_workflow_json).toBe(wire);
    expect(fixture.readPayload().body.inputs.trusted_workflow_json).toBe(wire);
    expect(record.request.inputs).not.toHaveProperty("validation_purpose");
    expect(record.request.wireInputs).not.toHaveProperty("publication_selection_json");
    expect(record.request.wireInputs).not.toHaveProperty("extension_test_exclude_patterns_json");
    expect(record.request.wireInputs).not.toHaveProperty("known_flaky_jobs_json");
    expect(Object.keys(fixture.readPayload().body.inputs)).toHaveLength(25);
    const before = readFileSync(fixture.requestPath());
    const callsBefore = fixture.calls().length;
    const gitBefore = fixture.gitCalls();
    const payloadBefore = fixture
      .readPayloadEvents()
      .filter((event) => event.stage !== "reconcile");
    const reopened = fixture.run(
      [
        "--request-file",
        fixture.requestPath(),
        "-f",
        "validation_purpose=publish",
        "-f",
        `publication_selection_json=${JSON.stringify(JSON.parse(selection))}`,
        "-f",
        `extension_test_exclude_patterns_json=${excludedJson}`,
      ],
      true,
    );
    expect(reopened.status, reopened.stderr).toBe(0);
    expect(fixture.gitCalls()).toEqual(gitBefore);
    expect(fixture.readPayloadEvents().filter((event) => event.stage !== "reconcile")).toEqual(
      payloadBefore,
    );
    expect(readFileSync(fixture.requestPath())).toEqual(before);
    const callsAfterReopen = fixture.calls();
    const changedExclusion = fixture.run(
      ["--request-file", fixture.requestPath(), "-f", "extension_test_exclude_patterns_json=[]"],
      true,
    );
    expect(changedExclusion.status).toBe(1);
    expect(fixture.calls()).toEqual(callsAfterReopen);
    expect(fixture.gitCalls()).toEqual(gitBefore);
    expect(changedExclusion.stderr).toContain("conflict with the retained request");
    expect(readFileSync(fixture.requestPath())).toEqual(before);
    expect(
      fixture
        .calls()
        .slice(callsBefore)
        .filter((args) => ghApiMethod(args) !== "GET"),
    ).toEqual([]);
    const mismatch = fixture.run(
      ["--request-file", fixture.requestPath(), "-f", "validation_purpose=diagnostic"],
      true,
    );
    expect(mismatch.status).toBe(1);
    expect(mismatch.stderr).toContain("conflict with the retained request");
    expect(readFileSync(fixture.requestPath())).toEqual(before);
  });

  it("reopens the original selected-plugin spelling after dispatch canonicalizes order and duplicates", () => {
    const fixture = createDispatchFixture();
    const original = JSON.stringify({
      route: "normal",
      npmDistTag: "latest",
      publishOpenclawNpm: false,
      pluginPublishScope: "selected",
      plugins: ["@openclaw/z", "@openclaw/a", "@openclaw/z"],
    });
    const request = [
      "--request-file",
      join(fixture.checkout, "request.json"),
      "-f",
      "validation_purpose=publish",
      "-f",
      `publication_selection_json=${original}`,
    ];
    const first = fixture.run(request);
    expect(first.status, first.stderr).toBe(0);
    const path = join(fixture.checkout, "request.json");
    const before = readFileSync(path);
    const record = JSON.parse(before.toString());
    expect(
      JSON.parse(record.request.wireInputs.trusted_workflow_json).publicationSelection.plugins,
    ).toEqual(["@openclaw/a", "@openclaw/z"]);
    const callsBefore = fixture.calls().length;
    const reopened = fixture.run(request, true);
    expect(reopened.status, reopened.stderr).toBe(0);
    expect(readFileSync(path)).toEqual(before);
    expect(
      fixture
        .calls()
        .slice(callsBefore)
        .every((args) => ghApiMethod(args) === "GET"),
    ).toBe(true);
  });

  it("reopens historical identity-only retained inputs without adding source intent or rewriting bytes", () => {
    const fixture = createDispatchFixture();
    const result = fixture.run();
    expect(result.status, result.stderr).toBe(0);
    const record = fixture.record();
    const envelope = JSON.parse(record.request.wireInputs.trusted_workflow_json);
    const legacyIdentity = JSON.stringify(envelope.trustedWorkflow, null, 1);
    record.request.inputs.trusted_workflow_json = legacyIdentity;
    record.request.wireInputs.trusted_workflow_json = legacyIdentity;
    writeFileSync(fixture.requestPath(), JSON.stringify(record) + "\n");
    const accepted = JSON.parse(readFileSync(fixture.acceptedRunPath, "utf8"));
    accepted.inputs.trusted_workflow_json = legacyIdentity;
    writeFileSync(fixture.acceptedRunPath, JSON.stringify(accepted));
    const before = readFileSync(fixture.requestPath());
    const callsBefore = fixture.calls().length;
    const reopened = fixture.run(["--reconcile-request", fixture.requestPath()], true);
    expect(reopened.status, reopened.stderr).toBe(0);
    expect(readFileSync(fixture.requestPath())).toEqual(before);
    expect(
      fixture
        .calls()
        .slice(callsBefore)
        .every((args) => ghApiMethod(args) === "GET"),
    ).toBe(true);
    const relabeled = fixture.run(
      ["--request-file", fixture.requestPath(), "-f", "validation_purpose=diagnostic"],
      true,
    );
    expect(relabeled.status).toBe(1);
    expect(readFileSync(fixture.requestPath())).toEqual(before);
  });

  it("normalizes GitHub witness inputs without depending on omitted blanks, order, or Boolean representation", () => {
    expect(dispatchInputsDigest({ text: "a=b\n$()", count: 3, flag: false, empty: "" })).toBe(
      dispatchInputsDigest({ empty: "", flag: "false", count: "3", text: "a=b\n$()" }),
    );
    expect(dispatchInputsDigest({ flag: true })).not.toBe(dispatchInputsDigest({ flag: false }));
    expect(dispatchInputsDigest({ flag: "" })).toBe(dispatchInputsDigest({}));
  });

  it("parses release validation dispatch args", () => {
    expect(
      parseArgs([
        "--sha",
        "abc123",
        "--workflow-sha",
        "a".repeat(40),
        "--trusted-workflow-ref",
        `release-publish/${"a".repeat(12)}-123`,
        "--target-ref",
        "release/2026.7.1",
        "--keep-branch",
        "--dry-run",
        "-f",
        "provider=anthropic",
        "--",
        "mode=linux",
      ]),
    ).toMatchObject({
      dryRun: true,
      keepBranch: true,
      inputs: {
        mode: "linux",
        provider: "anthropic",
        reuse_evidence: "true",
        fail_fast: "false",
      },
      sha: "abc123",
      targetRef: "release/2026.7.1",
      trustedWorkflowRef: `release-publish/${"a".repeat(12)}-123`,
      workflowSha: "a".repeat(40),
    });
  });

  it("accepts documented -f assignments after the option separator", () => {
    expect(
      parseArgs(["--", "-f", "release_profile=full", "-fmode=linux", "provider=anthropic"]).inputs,
    ).toMatchObject({
      mode: "linux",
      provider: "anthropic",
      release_profile: "full",
    });
    expect(() => parseArgs(["--", "-f"])).toThrow("-f requires a value");
  });

  it("requires an exact Tooling SHA for protected workflow tags", () => {
    const trustedTag = `release-publish/${"a".repeat(12)}-123`;
    expect(() => parseArgs(["--trusted-workflow-ref", trustedTag])).toThrow(
      "explicit full Tooling SHA",
    );
    expect(() =>
      parseArgs(["--workflow-sha", "a".repeat(40), "--trusted-workflow-ref", "release/2026.8.1"]),
    ).toThrow("protected release-publish");
  });

  it("rejects retry groups that are not controller APIs", () => {
    expect(() => parseArgs(["-f", "rerun_group=release-checks"])).toThrow(
      "rerun_group must be one of",
    );
    expect(() => parseArgs(["-f", "rerun_group=qa"])).toThrow("rerun_group must be one of");
    expect(parseArgs(["-f", "rerun_group=qa-parity"]).inputs.rerun_group).toBe("qa-parity");
  });

  it("infers the release profile from the target package version", () => {
    const readVersion = (version: string) => () => JSON.stringify({ version });

    expect(releaseProfileForTarget("a".repeat(40), readVersion("2026.7.1-beta.4"))).toBe("beta");
    expect(() => releaseProfileForTarget("a".repeat(40), readVersion("2026.7.1-alpha.4"))).toThrow(
      "Alpha releases are retired;",
    );
    expect(releaseProfileForTarget("a".repeat(40), readVersion("2026.7.1"))).toBe("stable");
    expect(releaseProfileForTarget("a".repeat(40), readVersion("2026.7.1-1"))).toBe("stable");
  });

  it("rejects missing option values", () => {
    expect(() => parseArgs(["--sha", "--dry-run"])).toThrow("--sha requires a value");
    expect(() => parseArgs(["--sha", "-h"])).toThrow("--sha requires a value");
    expect(() => parseArgs(["--workflow-sha", "--dry-run"])).toThrow(
      "--workflow-sha requires a value",
    );
    expect(() => parseArgs(["--workflow-sha", "-h"])).toThrow("--workflow-sha requires a value");
    expect(() => parseArgs(["--target-ref", "--dry-run"])).toThrow("--target-ref requires a value");
    expect(() => parseArgs(["-f", "--dry-run"])).toThrow("-f requires a value");
    expect(() => parseArgs(["-f", "-h"])).toThrow("-f requires a value");
  });

  it("accepts only canonical release branch or tag context", () => {
    expect(
      parseArgs(["--target-ref", "extended-stable/2026.6.33", "--workflow-sha", "a".repeat(40)])
        .targetRef,
    ).toBe("extended-stable/2026.6.33");
    expect(parseArgs(["--target-ref", "v2026.7.1-beta.5"]).targetRef).toBe("v2026.7.1-beta.5");
    expect(parseArgs(["--target-ref", "v2026.7.1"]).targetRef).toBe("v2026.7.1");
    expect(parseArgs(["--target-ref", "refs/tags/v2026.7.1-2"]).targetRef).toBe("v2026.7.1-2");
    expect(
      parseArgs(["--target-ref", "refs/heads/release/2026.7.1-2", "--workflow-sha", "a".repeat(40)])
        .targetRef,
    ).toBe("release/2026.7.1-2");
    for (const ref of [
      "feature/not-release",
      "release/2026.6.33-1",
      "v2026.6.33-1",
      "release/2026.7.1-beta.2",
      "refs/tags/release/2026.7.1",
      "refs/heads/v2026.7.1",
    ]) {
      expect(() => parseArgs(["--target-ref", ref])).toThrow(
        "canonical OpenClaw release branch or tag",
      );
    }
    expect(() => parseArgs(["--target-ref", "release/2026.7.1"])).toThrow(
      "requires --workflow-sha with an explicit full Tooling SHA",
    );
    expect(() =>
      parseArgs(["--target-ref", "release/2026.7.1", "--workflow-sha", "origin/main"]),
    ).toThrow("explicit full Tooling SHA");
  });

  it("requires a same-source base tag only when a correction uses base-version packages", () => {
    const targetSha = "a".repeat(40);
    for (const ref of ["release/2026.7.1-2", "v2026.7.1-2"]) {
      const resolveRef = (baseSha: string) => (requested: string) =>
        requested === "v2026.7.1" ? baseSha : targetSha;
      for (const baseSha of ["", "b".repeat(40)]) {
        expect(() =>
          verifyTargetRef(ref, targetSha, "2026.7.1", resolveRef(baseSha), () => true),
        ).toThrow("must use the same source commit as v2026.7.1");
      }
      expect(verifyTargetRef(ref, targetSha, "2026.7.1-2", resolveRef(""), () => true)).toBe(ref);
      for (const packageVersion of ["2026.7.2", "2026.7.1-beta.2", "2026.7.1-1"]) {
        expect(() =>
          verifyTargetRef(ref, targetSha, packageVersion, resolveRef(targetSha), () => true),
        ).toThrow("does not match release tag");
      }
    }
  });

  it("resolves annotated release tags through their peeled commit", () => {
    const calls: string[][] = [];
    const sha = resolveRemoteTargetRefSha("v2026.7.1-beta.5", (args) => {
      calls.push(args);
      return `b6387afd6d2e0f43c2ae98d2d124dbc277f03cca\t${args.at(-1)}`;
    });
    expect(sha).toBe("b6387afd6d2e0f43c2ae98d2d124dbc277f03cca");
    expect(calls).toEqual([["ls-remote", "--tags", "origin", "refs/tags/v2026.7.1-beta.5^{}"]]);
  });

  it("falls back to the direct ref for lightweight release tags", () => {
    const calls: string[][] = [];
    const sha = resolveRemoteTargetRefSha("v2026.7.1", (args) => {
      calls.push(args);
      return args.at(-1)?.endsWith("^{}")
        ? ""
        : "0123456789abcdef0123456789abcdef01234567\trefs/tags/v2026.7.1";
    });
    expect(sha).toBe("0123456789abcdef0123456789abcdef01234567");
    expect(calls).toEqual([
      ["ls-remote", "--tags", "origin", "refs/tags/v2026.7.1^{}"],
      ["ls-remote", "--tags", "origin", "refs/tags/v2026.7.1"],
    ]);
  });

  it("binds frozen release candidates to the branch or tag package version", () => {
    const candidateSha = "a".repeat(40);
    const branchTipSha = "b".repeat(40);
    const verify = (ref: string, version: string, remote = branchTipSha, reachable = true) =>
      verifyTargetRef(
        ref,
        candidateSha,
        version,
        () => remote,
        (ancestor, descendant) => reachable && ancestor === candidateSha && descendant === remote,
      );
    expect(verify("release/2026.7.1", "2026.7.1-beta.5")).toBe("release/2026.7.1");
    expect(() => verify("release/2026.7.1", "2026.7.1-alpha.5")).toThrow(
      "expected 2026.7.1 or a beta prerelease of it",
    );
    expect(() => verify("release/2026.7.1", "2026.7.1", branchTipSha, false)).toThrow(
      "is not reachable from release branch",
    );
    expect(() => verify("release/2026.7.1", "2026.6.9")).toThrow(
      "does not belong to release branch",
    );
    for (const version of ["2026.6.33", "2026.6.34", "2026.6.35"]) {
      expect(verify("extended-stable/2026.6.33", version)).toBe("extended-stable/2026.6.33");
    }
    for (const version of ["2026.6.32", "2026.7.35", "2026.6.35-beta.1", "2026.6.35-1"]) {
      expect(() => verify("extended-stable/2026.6.33", version)).toThrow(
        "does not belong to extended-stable branch",
      );
    }
    expect(verify("v2026.7.1-beta.5", "2026.7.1-beta.5", candidateSha, false)).toBe(
      "v2026.7.1-beta.5",
    );
    expect(() => verify("v2026.7.1-beta.5", "2026.7.1-beta.5")).toThrow("does not resolve");
    expect(() => verify("v2026.7.1-beta.5", "2026.7.1-beta.4", candidateSha)).toThrow(
      "does not match release tag",
    );
  });

  it("allows exact-target reuse to be disabled for a forced fresh run", () => {
    expect(parseArgs(["-f", "reuse_evidence=false"]).inputs.reuse_evidence).toBe("false");
    expect(() => parseArgs(["-f", "reuse_evidence=maybe"])).toThrow(
      "reuse_evidence must be true or false",
    );
    expect(parseArgs(["-f", "fail_fast=true"]).inputs.fail_fast).toBe("true");
    expect(() => parseArgs(["-f", "fail_fast=maybe"])).toThrow("fail_fast must be true or false");
    expect(() => parseArgs(["-f", "release_profile=minimum"])).toThrow(
      "release_profile must be beta, stable, or full",
    );
    expect(() => parseArgs(["-f", "allow_unreleased_changelog=maybe"])).toThrow(
      "allow_unreleased_changelog must be true or false",
    );
  });

  it("reserves immutable candidate identity inputs for the resolved --sha", () => {
    expect(() => parseArgs(["-f", "ref=other"])).toThrow("reserves the ref input");
    expect(() => parseArgs(["--", "ref=other"])).toThrow("reserves the ref input");
    expect(() => parseArgs(["-f", `expected_sha=${"a".repeat(40)}`])).toThrow(
      "reserves expected_sha",
    );
    expect(() => parseArgs(["--", `expected_sha=${"a".repeat(40)}`])).toThrow(
      "reserves expected_sha",
    );
    expect(() => parseArgs(["-f", "trusted_workflow_json={}"])).toThrow(
      "reserves trusted_workflow_json",
    );
  });

  it("validates direct and reused runs through the strict evidence verifier", () => {
    const workflowSha = "a".repeat(40);
    const verifier = "/tmp/trusted/scripts/release-ci-summary.mjs";
    expect(releaseEvidenceVerificationArgs("123", workflowSha, verifier)).toEqual([
      "--validate-run",
      "123",
      "--trusted-workflow-ref",
      "main",
      "--trusted-workflow-full-ref",
      "refs/heads/main",
      "--trusted-workflow-sha",
      workflowSha,
      "--json",
      "--verifier-source-sha",
      workflowSha,
      "--verifier-source-file",
      verifier,
    ]);
    expect(() => releaseEvidenceVerificationArgs("", workflowSha, verifier)).toThrow(
      "positive decimal",
    );
    const trustedTag = `release-publish/${workflowSha.slice(0, 12)}-123`;
    expect(releaseEvidenceVerificationArgs("123", workflowSha, verifier, trustedTag)).toEqual([
      "--validate-run",
      "123",
      "--trusted-workflow-ref",
      trustedTag,
      "--trusted-workflow-full-ref",
      `refs/tags/${trustedTag}`,
      "--trusted-workflow-sha",
      workflowSha,
      "--json",
      "--verifier-source-sha",
      workflowSha,
      "--verifier-source-file",
      verifier,
    ]);
    expect(() =>
      releaseEvidenceVerificationArgs("123", workflowSha, verifier, "release/2026.8.1"),
    ).toThrow("protected release-publish tag");
  });

  it("accepts only exact protected workflow tags outside main ancestry", () => {
    const sha = "a".repeat(40);
    const tag = `release-publish/${sha.slice(0, 12)}-123`;
    const verify = (ref: string, remote = "", mainAncestor = false) =>
      verifyTrustedWorkflowRef(
        sha,
        ref,
        () => remote,
        () => mainAncestor,
      );
    expect(() => verify("main", "", true)).not.toThrow();
    expect(() => verify("main")).toThrow("not reachable from current origin/main");
    expect(() => verify(tag, sha)).not.toThrow();
    expect(() => verify(`release-publish/${"b".repeat(12)}-123`, sha)).toThrow(
      "does not match Tooling SHA",
    );
    expect(() => verify(tag)).toThrow("does not exist on origin");
    expect(() => verify(tag, "c".repeat(40))).toThrow(`expected ${sha}`);
    expect(() => verify("release/2026.8.1", sha)).toThrow("protected release-publish");
  });

  it("bounds run discovery with backoff through cached registration lag", () => {
    const fixture = createDispatchFixture({
      runDiscoveryMisses: 4,
    });
    const result = fixture.run();
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("Could not determine Full Release Validation run id:");
    expect(fixture.readWaits()).toEqual([30_000, 60_000, 120_000]);
    const calls = fixture.calls();
    expect(
      calls.filter((args) => ghApiEndpoint(args).endsWith("/actions/workflows/17/runs")),
    ).toHaveLength(4);
  });

  it("keeps waiting while the exact run is queued before its witness upload", () => {
    const queued = { conclusion: null, status: "queued" };
    const fixture = createDispatchFixture({
      parentRunStates: [
        ...Array.from({ length: 6 }, () => queued),
        { conclusion: "success", status: "completed" },
      ],
      witnessMissingReads: 6,
    });
    const result = fixture.run();
    expect(result.status, result.stderr).toBe(0);
    expect(result.stderr).toContain("dispatch=pending-witness: run 123 (queued)");
    expect(fixture.readWaits()).toEqual([30_000, 60_000, 120_000, 120_000, 120_000, 120_000]);
    expect(fixture.record()).toMatchObject({
      phase: "observed",
      run: { id: 123, attempt: 1 },
    });
  });

  it("delivers the complete wire body through a private, bounded, short-lived payload", () => {
    const fixture = createDispatchFixture();
    const value = "spaces 'quotes' \"double\" = & ? $() `command`\n\u00e9\u65e5\u672c";
    const result = fixture.run([
      "-f",
      `live_suite_filter=${value}`,
      "-f",
      "run_release_soak=true",
      "-f",
      "reuse_evidence=false",
    ]);
    expect(result.status, result.stderr).toBe(0);
    const payload = fixture.readPayload();
    const intent = fixture.record();
    expect(payload.body).toEqual({
      ref: intent.request.workflowRef,
      inputs: intent.request.wireInputs,
    });
    expect(payload.body.inputs).toMatchObject({
      live_suite_filter: value,
      cross_os_suite_filter: "",
      run_release_soak: "true",
      reuse_evidence: "false",
    });
    expect(Object.values(payload.body.inputs).every((input) => typeof input === "string")).toBe(
      true,
    );
    expect(payload.bytes).toBe(Buffer.byteLength(JSON.stringify(payload.body)));
    expect(payload.bytes).toBeGreaterThan(JSON.stringify(payload.body).length);
    expect(payload.bytes).toBeLessThanOrEqual(128 * 1024);
    expect(payload).toMatchObject({ regularFile: true, fileMode: 0o600, directoryMode: 0o700 });
    const calls = fixture.calls();
    expect(calls.filter(isWorkflowDispatch)).toEqual([
      [
        "api",
        "--include",
        "--method",
        "POST",
        "repos/openclaw/openclaw/actions/workflows/full-release-validation.yml/dispatches",
        "--hostname",
        "github.com",
        "--input",
        payload.path,
      ],
    ]);
    expect(JSON.stringify(calls)).not.toContain(value);
    expect(result.stdout + result.stderr).not.toContain(value);
    const events = fixture.readPayloadEvents();
    expect(events.slice(0, 4).map((event) => event.stage)).toEqual([
      "created",
      "write",
      "post",
      "cleanup",
    ]);
    expect(events[1]?.options).toEqual({ flag: "wx", mode: 0o600 });
    expect(events[4]?.stage).toBe("reconcile");
    expect(existsSync(payload.path)).toBe(false);
    expect(existsSync(payload.directory)).toBe(false);
    expect(intent).toMatchObject({
      phase: "observed",
      error: "none",
      run: { id: 123, attempt: 1 },
    });
  });

  it("does not mutate remote refs when payload write preparation fails", () => {
    const fixture = createDispatchFixture({ payloadPreparationFailure: "write" });
    const result = fixture.run();
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("injected payload write failure");
    expect(fixture.calls().filter((call) => ghApiMethod(call) !== "GET")).toEqual([]);
    expect(fixture.gitCalls().filter((call) => call[0] === "push")).toEqual([]);
    expect(fixture.record()).toMatchObject({
      phase: "prepared",
      error: "none",
      run: null,
      refs: { workflow: "intended" },
    });
    const events = fixture.readPayloadEvents();
    expect(events.map((event) => event.stage)).toEqual(["created", "write", "cleanup"]);
    for (const event of events) {
      expect(existsSync(event.path)).toBe(false);
    }
  });

  it("rejects oversized UTF-8 inputs before payload preparation or remote mutation", () => {
    const fixture = createDispatchFixture();
    const result = fixture.run(["-f", `live_suite_filter=${"\u00e9".repeat(34_000)}`]);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("Dispatch request exceeds its byte limit");
    expect(fixture.readPayloadEvents()).toEqual([]);
    expect(fixture.calls().filter((call) => ghApiMethod(call) !== "GET")).toEqual([]);
    expect(fixture.gitCalls().filter((call) => call[0] === "push")).toEqual([]);
  });

  it.each([
    {
      name: "unknown transport",
      options: { dispatchFailure: true },
      status: 1,
      phase: "attempted",
      error: "unclassified",
      deleted: 0,
    },
    {
      name: "accepted response loss",
      options: { acceptedDispatchFailure: true },
      status: 0,
      phase: "observed",
      error: "transport",
      deleted: 1,
    },
  ])(
    "preserves $name despite payload cleanup failure",
    ({ options, status, phase, error, deleted }) => {
      const fixture = createDispatchFixture({ ...options, payloadCleanupFailure: true });
      const result = fixture.run();
      expect(result.status, result.stderr).toBe(status);
      const payload = fixture.readPayload();
      expect(existsSync(payload.path)).toBe(true);
      expect(result.stderr).toContain(
        `Could not remove dispatch payload directory: ${JSON.stringify(payload.directory)}`,
      );
      expect(result.stderr).not.toContain("private-cleanup-error-must-not-be-logged");
      expect(fixture.record()).toMatchObject({
        phase,
        error,
      });
      const calls = fixture.calls();
      expect(calls.filter(isWorkflowDispatch)).toHaveLength(1);
      expect(calls.filter((call) => ghApiMethod(call) === "DELETE")).toHaveLength(deleted);
      expect(fixture.refs()).toHaveLength(1 - deleted);
      const stages = fixture.readPayloadEvents().map((event) => event.stage);
      expect(stages.slice(0, 4)).toEqual(["created", "write", "post", "cleanup"]);
      expect(stages[4]).toBe("reconcile");
    },
  );

  it("rejects a run from an unrelated workflow event", () => {
    const fixture = createDispatchFixture({ runIdentityOverrides: { event: "push" } });
    const result = fixture.run();
    expect(result.status, result.stdout).toBe(1);
    expect(result.stdout).not.toContain("ok release evidence");
    expect(fixture.calls("DELETE")).toEqual([]);
  });

  it.each([
    {
      name: "packed lane",
      marker: "FULL_RELEASE_LANE_INPUTS_CONTRACT",
      input: 'extension_test_exclude_patterns_json=["extensions/example/src/example.test.ts"]',
      error: "does not support packed lane inputs",
    },
    {
      name: "declared flake",
      marker: undefined,
      input: 'known_flaky_jobs_json=["normalCi:checks-node"]',
      error: "Automatic test retries are disabled",
    },
  ])(
    "refuses unsupported $name controls before creating refs or dispatching",
    ({ marker, input, error }) => {
      const fixture = createDispatchFixture({
        workflowSource: marker
          ? CURRENT_WORKFLOW_SOURCE.replace(`  ${marker}: "1"\n`, "")
          : CURRENT_WORKFLOW_SOURCE,
      });
      const result = fixture.run(["-f", input]);
      expect(result.status).toBe(1);
      expect(result.stderr).toContain(error);
      expect(fixture.calls()).toEqual([]);
    },
  );

  it("rejects obsolete retained target-ref fields before Git or remote access", () => {
    const fixture = createDispatchFixture();
    expect(fixture.run().status).toBe(0);
    const path = fixture.requestPath();
    const record = JSON.parse(readFileSync(path, "utf8"));
    const ghCalls = readFileSync(fixture.ghCallsPath, "utf8");
    const gitCalls = readFileSync(fixture.gitCallsPath, "utf8");
    for (const fields of ["request", "refs", "both"]) {
      const legacy = {
        ...record,
        request: {
          ...record.request,
          ...(fields !== "refs"
            ? { targetRef: `validation/target-${fixture.targetSha.slice(0, 12)}-123` }
            : {}),
        },
        refs: { ...record.refs, ...(fields !== "request" ? { target: "created" } : {}) },
      };
      const bytes = `${JSON.stringify(legacy)}\n`;
      writeFileSync(path, bytes);
      const result = fixture.run(["--reconcile-request", path], true);
      expect(result.status).toBe(1);
      expect(result.stderr).toContain(
        fields === "refs"
          ? "Invalid retained dispatch outcome"
          : "Invalid retained dispatch request identity",
      );
      expect(readFileSync(path, "utf8")).toBe(bytes);
    }
    expect(readFileSync(fixture.ghCallsPath, "utf8")).toBe(ghCalls);
    expect(readFileSync(fixture.gitCallsPath, "utf8")).toBe(gitCalls);
  });

  it.each(["missing", "truncated", "oversized", "symlink", "parent symlink", "public"] as const)(
    "refuses a %s request before any remote or Git access",
    (kind) => {
      const fixture = createDispatchFixture();
      let path = join(fixture.checkout, "request.json");
      if (kind === "truncated") {
        writeFileSync(path, '{"kind":', { mode: 0o600 });
      } else if (kind === "oversized") {
        writeFileSync(path, "x".repeat(129 * 1024), { mode: 0o600 });
      } else if (kind === "symlink") {
        symlinkSync(join(fixture.checkout, "missing.json"), path);
      } else if (kind === "parent symlink") {
        symlinkSync(fixture.checkout, join(fixture.checkout, "linked"));
        path = join(fixture.checkout, "linked", "request.json");
      } else if (kind === "public") {
        writeFileSync(path, "{}\n", { mode: 0o644 });
      }
      const result = fixture.run(["--reconcile-request", path], true);
      expect(result.status).toBe(1);
      expect(fixture.calls()).toEqual([]);
      expect(fixture.gitCalls()).toEqual([]);
    },
  );

  it("refuses witness-incapable frozen tooling before remote creation", () => {
    const fixture = createDispatchFixture({
      workflowSource: CURRENT_WORKFLOW_SOURCE.replace(
        '  FULL_RELEASE_DISPATCH_WITNESS_CONTRACT: "1"\n',
        "",
      ),
    });
    const result = fixture.run();
    expect(result.status).toBe(1);
    expect(result.stderr).toContain(
      `Tooling SHA ${fixture.workflowSha} does not support FULL_RELEASE_DISPATCH_WITNESS_CONTRACT=1`,
    );
    expect(fixture.calls()).toEqual([]);
    expect(fixture.gitCalls().some((args) => args[0] === "push")).toBe(false);
    expect(fixture.refs()).toEqual([]);
  });

  it.each([
    {
      name: "intent write fails",
      options: { failIntentWrite: true },
      status: 1,
      phase: "prepared",
    },
    {
      name: "process exits before POST",
      options: { stopBeforeDispatch: true },
      status: 77,
      phase: "attempted",
    },
  ])("does not redispatch when $name", ({ options, status, phase }) => {
    const fixture = createDispatchFixture(options);
    const result = fixture.run();
    expect(result.status, result.stderr).toBe(status);
    const path = fixture.requestPath();
    expect(JSON.parse(readFileSync(path, "utf8")).phase).toBe(phase);
    const before = readFileSync(path, "utf8");
    const recovery = fixture.run(["--reconcile-request", path], true);
    expect(recovery.status).toBe(1);
    expect(recovery.stderr).toContain("dispatch=unknown");
    expect(readFileSync(path, "utf8")).toBe(before);
    expect(fixture.dispatches()).toEqual([]);
  });

  it("allows only the claimed caller to POST when another caller reopens concurrently", () => {
    const fixture = createDispatchFixture({ reopenDuringDispatch: true });
    const result = fixture.run();
    expect(result.status, result.stderr).toBe(0);
    expect(fixture.dispatches()).toHaveLength(1);
  });

  it.each([{ ghRoute: "path" as const, tokenPresent: false }])(
    "reads witness bytes through $ghRoute CLI without Node fetch (token=$tokenPresent)",
    ({ ghRoute, tokenPresent }) => {
      const fixture = createDispatchFixture({
        archiveEscapeFlag: "required",
        ghRoute,
        tokenPresent,
      });
      const result = fixture.run();
      expect(result.status, result.stderr).toBe(0);
      const calls = fixture.calls();
      expect(calls.filter((args) => args[0] === "auth")).toEqual([]);
      expect(readFileSync(fixture.fetchCallsPath, "utf8")).toBe("");
      const reads = readFileSync(fixture.artifactTransportPath, "utf8")
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line));
      expect(reads).toHaveLength(2);
      expect(reads[0]).toMatchObject({ timeout: 60_000, maxBuffer: 128 * 1024 });
      expect(reads[1]).toMatchObject({
        encoding: null,
        timeout: 60_000,
        maxBuffer: 256 * 1024,
      });
      for (const { args } of reads) {
        expect(ghApiMethod(args)).toBe("GET");
        expect(args[args.indexOf("--hostname") + 1]).toBe("github.com");
        expect(args).toContain("Cache-Control: max-age=0");
        expect(args).not.toContain("--include");
      }
      expect(ghApiEndpoint(reads[0].args)).toBe("repos/openclaw/openclaw/actions/artifacts/9001");
      expect(ghApiEndpoint(reads[1].args)).toBe(
        "repos/openclaw/openclaw/actions/artifacts/9001/zip",
      );
      expect(reads[1].args).toContain("--allow-escape-sequences");
      expect(fixture.readCalls(fixture.pathGhCallsPath)).toEqual(ghRoute === "path" ? calls : []);
      expect(fixture.record().phase).toBe("observed");
    },
  );

  it("falls back once when gh does not support the binary-output flag", () => {
    const fixture = createDispatchFixture({ archiveEscapeFlag: "unsupported" });
    const result = fixture.run();
    expect(result.status, result.stderr).toBe(0);
    const archiveReads = readFileSync(fixture.artifactTransportPath, "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line))
      .filter(({ args }) => ghApiEndpoint(args).endsWith("/zip"));
    expect(archiveReads).toHaveLength(2);
    expect(archiveReads[0].args).toContain("--allow-escape-sequences");
    expect(archiveReads[1].args).not.toContain("--allow-escape-sequences");
  });

  it("does not retry unrelated witness archive failures", () => {
    const fixture = createDispatchFixture({
      archiveEscapeFlag: "required",
      artifactReadError: "archive",
    });
    const result = fixture.run();
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("dispatch=unknown");
    const archiveReads = readFileSync(fixture.artifactTransportPath, "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line))
      .filter(({ args }) => ghApiEndpoint(args).endsWith("/zip"));
    expect(archiveReads).toHaveLength(1);
    expect(archiveReads[0].args).toContain("--allow-escape-sequences");
  });

  it.each([
    { name: "nonpositive ID", artifactMetadata: { id: 0 } },
    { name: "oversized declaration", artifactMetadata: { size_in_bytes: 256 * 1024 + 1 } },
    { name: "invalid digest", artifactMetadata: { digest: "sha256:invalid" } },
    { name: "expired flag", artifactMetadata: { expired: true } },
    { name: "elapsed expiry", artifactMetadata: { expires_at: "2000-01-01T00:00:00Z" } },
    {
      name: "changed SHA",
      exactArtifactMetadata: { workflow_run: { id: 123, head_sha: "c".repeat(40) } },
    },
    { name: "oversized metadata", oversizedArtifactMetadata: true },
    { name: "oversized archive", archiveFailure: "oversized" as const },
    { name: "corrupt ZIP with matching digest", archiveFailure: "corrupt" as const },
    { name: "mismatched archive digest", archiveFailure: "digest" as const },
  ])("refuses witness $name without fallback or remote cleanup", ({ name: _name, ...options }) => {
    const fixture = createDispatchFixture({
      ...options,
      ghRoute: "path",
      tokenPresent: false,
    });
    const result = fixture.run();
    expect(result.status, result.stdout).toBe(1);
    expect(result.stderr).toContain("dispatch=unknown");
    expect(result.stdout).not.toContain("ok release evidence");
    const calls = fixture.calls();
    expect(calls.filter(isWorkflowDispatch)).toHaveLength(1);
    expect(calls.filter((args) => ghApiMethod(args) === "DELETE")).toEqual([]);
    expect(calls.filter((args) => args[0] === "auth")).toEqual([]);
    expect(readFileSync(fixture.fetchCallsPath, "utf8")).toBe("");
    expect(fixture.record().phase).toBe("attempted");
    expect(fixture.refs()).toHaveLength(1);
  });

  it.each(["full-ref"] as const)(
    "accepts the %s exact workflow path representation",
    (runPathStyle) => {
      const fixture = createDispatchFixture({ runPathStyle });
      const result = fixture.run();
      expect(result.status, result.stderr).toBe(0);
      expect(fixture.record()).toMatchObject({
        phase: "observed",
        run: { id: 123, attempt: 1 },
      });
      expect(fixture.dispatches()).toHaveLength(1);
    },
  );

  it.each([
    { name: "second-page duplicate", options: { duplicateOnSecondPage: true } },
    {
      name: "missing next page",
      options: { duplicateOnSecondPage: true, incompletePagination: true },
    },
    { name: "missing witness", options: { witnessMissing: true } },
    { name: "duplicate witness", options: { witnessDuplicate: true } },
    {
      name: "wrong repository",
      options: { runIdentityOverrides: { repository: { full_name: "example/other" } } },
    },
    {
      name: "foreign full-ref suffix",
      options: {
        runIdentityOverrides: {
          path: ".github/workflows/full-release-validation.yml@refs/heads/main",
        },
      },
    },
    { name: "wrong tooling SHA", options: { runIdentityOverrides: { head_sha: "c".repeat(40) } } },
    { name: "wrong transport", options: { runIdentityOverrides: { head_branch: "main" } } },
  ])("leaves $name unresolved without verification or cleanup", ({ options }) => {
    const fixture = createDispatchFixture(options);
    const result = fixture.run();
    expect(result.status, result.stdout).toBe(1);
    expect(result.stderr).toContain("dispatch=unknown");
    expect(result.stdout).not.toContain("ok release evidence");
    const calls = fixture.calls();
    expect(calls.filter(isWorkflowDispatch)).toHaveLength(1);
    expect(calls.filter((args) => ghApiMethod(args) === "DELETE")).toEqual([]);
    if (options.duplicateOnSecondPage && !options.incompletePagination) {
      expect(calls.some((args) => ghField(args, "page") === "2")).toBe(true);
    }
  });

  it.each(["provider"])("does not adopt a run with a different %s input witness", (key) => {
    const fixture = createDispatchFixture({ witnessInputs: { [key]: "__different_input__" } });
    const result = fixture.run();
    expect(result.status, result.stdout).toBe(1);
    expect(result.stderr).toContain(
      "Dispatch input witness does not match the complete retained request",
    );
    expect(fixture.calls("DELETE")).toEqual([]);
  });

  it.each([
    ["beta", false],
    ["full", true],
  ] as const)(
    "retains raw defaults separately from effective %s soak",
    (profile, effectiveSoak) => {
      const fixture = createDispatchFixture();
      const result = fixture.run(["-f", `release_profile=${profile}`]);
      expect(result.status, result.stderr).toBe(0);
      const record = fixture.record();
      expect(record.request).toMatchObject({
        effectiveSoak,
        inputs: {
          run_release_soak: false,
          fail_fast: false,
          reuse_evidence: true,
          live_suite_filter: "",
          cross_os_suite_filter: "",
        },
        wireInputs: { run_release_soak: "false", fail_fast: "false", reuse_evidence: "true" },
      });
      expect(record.run).toEqual({ id: 123, attempt: 1 });
      expect(record.error).toBe("none");
    },
  );

  it.each([422])(
    "retains HTTP %s rejection without adopting or redispatching",
    (dispatchHttpStatus) => {
      const fixture = createDispatchFixture({ dispatchHttpStatus });
      const result = fixture.run();
      expect(result.status).toBe(1);
      expect(result.stderr).toContain("dispatch=rejected");
      const path = fixture.requestPath();
      expect(JSON.parse(readFileSync(path, "utf8")).phase).toBe("rejected");
      const calls = readFileSync(fixture.ghCallsPath, "utf8");
      const recovery = fixture.run(["--reconcile-request", path], true);
      expect(recovery.status).toBe(1);
      expect(recovery.stderr).toContain("dispatch=rejected");
      expect(readFileSync(fixture.ghCallsPath, "utf8")).toBe(calls);
    },
  );

  it("does not retain or mutate a request in dry-run mode", () => {
    const fixture = createDispatchFixture();
    const result = fixture.run(["--dry-run"]);
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain("(dry run; not written)");
    expect(result.stdout).toContain(`Validation SHA fetchable by bare SHA: ${fixture.targetSha}`);
    expect(result.stdout).not.toContain("validation/target-");
    const fetch = fixture
      .gitCalls()
      .find((args) => args.includes("https://github.com/openclaw/openclaw.git"));
    expect(fetch).toEqual([
      "-C",
      expect.any(String),
      "fetch",
      "--no-tags",
      "--depth=1",
      "--filter=blob:none",
      "https://github.com/openclaw/openclaw.git",
      fixture.targetSha,
    ]);
    expect(fetch![1]).not.toBe(fixture.checkout);
    expect(existsSync(fetch![1]!)).toBe(false);
    expect(runGit(fixture.checkout, ["rev-parse", "--is-shallow-repository"])).toBe("false");
    expect(fixture.readPayloadEvents()).toEqual([]);
    expect(fixture.calls()).toEqual([]);
    expect(fixture.gitCalls().some((args) => args[0] === "push")).toBe(false);
  });

  it("binds release decisions to the exact parent attempt and tooling SHA", () => {
    const payload = {
      kind: "openclaw.full-release-decision",
      mode: "decision",
      parentRunAttempt: 2,
      sourceParentRunAttempt: 1,
      parentRunId: "123",
      activeRunIds: ["101"],
      blockers: [{ child: "normalCi", job: "test", runId: "101" }],
      cancellation: { cancelledRunIds: [], requested: false },
      children: {},
      errors: [],
      executionPlanSha256: "c".repeat(64),
      releaseProfile: "stable",
      rerunGroup: "ci",
      state: "blocked_diagnostics_running",
      targetSha: "b".repeat(40),
      version: 2,
      workflowRef: "main",
      workflowSha: "a".repeat(40),
    };
    expect(
      validateReleaseDecisionPayload(payload, {
        parentRunAttempt: 2,
        parentRunId: "123",
        workflowSha: "a".repeat(40),
      }),
    ).toMatchObject(payload);
    expect(releaseDecisionStopsForeground("blocked_diagnostics_running")).toBe(true);
    expect(releaseDecisionStopsForeground("passed")).toBe(false);
    expect(() =>
      validateReleaseDecisionPayload(
        { ...payload, parentRunAttempt: 3 },
        {
          parentRunAttempt: 2,
          parentRunId: "123",
          workflowSha: "a".repeat(40),
        },
      ),
    ).toThrow("binding is invalid");
  });

  it("treats only transient Release Decision download failures as unavailable this poll", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      expect(
        tryReadReleaseDecision("123", 1, "a".repeat(40), () => ({
          error: undefined,
          signal: null,
          status: 1,
          stderr: "HTTP 503: Server Error",
          stdout: "",
        })),
      ).toBeUndefined();
      expect(warn).toHaveBeenCalledWith(
        expect.stringContaining("Release Decision artifact unavailable this poll"),
      );
      expect(() =>
        tryReadReleaseDecision("123", 1, "a".repeat(40), () => ({
          error: undefined,
          signal: null,
          status: 1,
          stderr: "HTTP 403: Bad credentials",
          stdout: "",
        })),
      ).toThrow("Release Decision artifact download failed");
    } finally {
      warn.mockRestore();
    }
  });

  it.each(["no valid artifacts found to download"])(
    "treats missing named Release Decision artifacts as unavailable: %s",
    (stderr) => {
      expect(
        tryReadReleaseDecision("123", 1, "a".repeat(40), () => ({
          error: undefined,
          signal: null,
          status: 1,
          stderr,
          stdout: "",
        })),
      ).toBeUndefined();
    },
  );

  it("rejects incomplete trusted release harnesses before dispatch", () => {
    const workflowPath = ".github/workflows/full-release-validation.yml";
    const verifierPath = "scripts/release-ci-summary.mjs";
    const checked: string[] = [];
    expect(
      assertTrustedWorkflowHarness(
        "a".repeat(40),
        (relativePath) => {
          checked.push(relativePath);
          return relativePath === workflowPath || relativePath === verifierPath;
        },
        () => CURRENT_WORKFLOW_SOURCE,
      ),
    ).toEqual({ contract: "2", verifierPath });
    expect(checked).toEqual([workflowPath, verifierPath]);
    expect(() => assertTrustedWorkflowHarness("a".repeat(40), () => false)).toThrow(workflowPath);
    expect(() =>
      assertTrustedWorkflowHarness(
        "a".repeat(40),
        (relativePath) => relativePath === workflowPath,
        () => CURRENT_WORKFLOW_SOURCE,
      ),
    ).toThrow("supported release evidence verifier");
    expect(() =>
      assertTrustedWorkflowHarness(
        "b".repeat(40),
        () => true,
        () => LEGACY_WORKFLOW_SOURCE,
      ),
    ).toThrow("does not declare a supported RELEASE_ISOLATION_TOOLING_CONTRACT");
    expect(() =>
      assertTrustedWorkflowHarness(
        "b".repeat(40),
        () => true,
        () =>
          'env:\n  RELEASE_ISOLATION_TOOLING_CONTRACT: "2"\non:\n  workflow_dispatch:\n    inputs: {}\n',
      ),
    ).toThrow(`Tooling SHA ${"b".repeat(40)} is missing workflow_dispatch input expected_sha`);
    expect(() =>
      assertTrustedWorkflowHarness(
        "b".repeat(40),
        () => true,
        () =>
          'env:\n  RELEASE_ISOLATION_TOOLING_CONTRACT: "2"\non:\n  workflow_dispatch:\n    inputs:\n      expected_sha: {}\n',
      ),
    ).toThrow("missing workflow_dispatch input trusted_workflow_json");
    expect(
      assertTrustedWorkflowHarness(
        "b".repeat(40),
        () => true,
        () => CONTRACT_ONE_WORKFLOW_SOURCE,
      ),
    ).toEqual({ contract: "1", verifierPath });
  });

  it("retains a failed parent workflow ref for GitHub reruns", () => {
    const shouldDelete = (parentConclusion: string, evidenceVerified = false, dryRun = false) =>
      shouldDeleteTemporaryWorkflowRef({
        parentConclusion,
        evidenceVerified,
        dryRun,
        keepBranch: false,
      });
    expect(shouldDelete("failure")).toBe(false);
    expect(shouldDelete("success", true)).toBe(true);
    expect(shouldDelete("", false, true)).toBe(true);
    expect(shouldDelete("success")).toBe(false);
  });

  it("rejects missing version notes before creating remote refs or dispatching", () => {
    const fixture = createDispatchFixture({
      targetSource: { "CHANGELOG.md": "## 2026.7.9\n\nAn older release with substantive notes.\n" },
    });
    const result = fixture.run();
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("does not contain a release section for 2026.8.1");
    expect(fixture.gitCalls().filter((call) => call[0] === "push")).toEqual([]);
    expect(fixture.calls().filter((call) => ghApiMethod(call) !== "GET")).toEqual([]);
    expect(fixture.dispatches()).toEqual([]);
  });

  it("dispatches a frozen correction candidate and removes only its workflow ref", () => {
    const fixture = createDispatchFixture();
    const releaseRef = `${fixture.releaseRef}-2`;
    runGit(fixture.checkout, ["branch", releaseRef, fixture.targetSha]);
    runGit(fixture.checkout, ["tag", "-a", "v2026.8.1", fixture.targetSha, "-m", "base release"]);
    runGit(fixture.checkout, ["push", "origin", `refs/heads/${releaseRef}`, "refs/tags/v2026.8.1"]);
    expect(runGit(fixture.origin, ["tag", "--list", "v2026.8.1-2"])).toBe("");
    const result = fixture.run(["--target-ref", releaseRef]);
    expect(result.status, result.stderr).toBe(0);
    const creates = fixture
      .calls("POST")
      .filter((args) => ghApiEndpoint(args).endsWith("/git/refs"));
    expect(creates).toHaveLength(1);
    const branch = ghField(creates[0]!, "ref");
    expect(branch).toMatch(
      new RegExp(`^refs/heads/release-ci/${fixture.workflowSha.slice(0, 12)}-[0-9]+$`, "u"),
    );
    expect(ghField(creates[0]!, "sha")).toBe(fixture.workflowSha);
    const payload = fixture.readPayload();
    expect(payload.body.ref).toBe(branch.slice("refs/heads/".length));
    expect(payload.body.inputs).toMatchObject({
      ref: fixture.targetSha,
      expected_sha: fixture.targetSha,
      target_context_ref: releaseRef,
      allow_unreleased_changelog: "false",
    });
    expect(JSON.parse(payload.body.inputs.trusted_workflow_json ?? "{}").trustedWorkflow).toEqual({
      ref: "main",
      fullRef: "refs/heads/main",
      sha: fixture.workflowSha,
    });
    expect(fixture.gitCalls().filter((args) => args[0] === "push")).toEqual([]);
    expect(fixture.calls("DELETE").map(ghApiEndpoint)).toEqual([
      `repos/openclaw/openclaw/git/refs/${branch.slice("refs/".length)}`,
    ]);
    expect(runGit(fixture.origin, ["for-each-ref", "--format=%(refname)", "refs/heads"])).toBe(
      ["refs/heads/main", `refs/heads/${fixture.releaseRef}`, `refs/heads/${releaseRef}`].join(
        "\n",
      ),
    );
    expect(result.stdout).toContain("ok release evidence current=123 root=123");
  });

  it("retains uncertain workflow ref state when creation has an ambiguous failure", () => {
    const fixture = createDispatchFixture({ createRefFailure: true });
    const result = fixture.run();
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("configured workflow ref creation failure");
    expect(fixture.record().refs).toEqual({
      workflow: "uncertain",
    });
    const calls = fixture.calls();
    const createCalls = calls.filter((args) => args[0] === "api" && ghApiMethod(args) === "POST");
    const deleteCalls = calls.filter((args) => args[0] === "api" && ghApiMethod(args) === "DELETE");
    expect(createCalls).toHaveLength(1);
    expect(deleteCalls).toHaveLength(0);
    expect(calls.some(isWorkflowDispatch)).toBe(false);
    expect(fixture.gitCalls().filter((args) => args[0] === "push")).toEqual([]);
    expect(fixture.refs()).toHaveLength(0);
  });

  it.each([true])(
    "rejects a failed bare-SHA preflight before retaining or mutating (dryRun=%s)",
    (dryRun) => {
      const fixture = createDispatchFixture({
        includeTargetRef: false,
        targetAlreadyRemote: false,
        bareShaFetchFailure: true,
      });
      const result = fixture.run(dryRun ? ["--dry-run"] : []);
      expect(result.status).toBe(1);
      expect(result.stderr).toContain(
        `GitHub refused to serve Validation SHA ${fixture.targetSha} by bare SHA; child checkouts fetch it the same way, so dispatch would fail.`,
      );
      expect(result.stderr).toContain("upload-pack: not our ref");
      expect(fixture.calls()).toEqual([]);
      const gitCalls = fixture.gitCalls();
      expect(gitCalls.filter((args) => args[0] === "push")).toEqual([]);
      const fetch = gitCalls.find((args) =>
        args.includes("https://github.com/openclaw/openclaw.git"),
      );
      expect(fetch).toBeDefined();
      expect(existsSync(fetch![1]!)).toBe(false);
      expect(existsSync(join(fixture.checkout, ".artifacts", "full-release-validation"))).toBe(
        false,
      );
    },
  );

  it("reports a workflow ref cleanup failure", () => {
    const fixture = createDispatchFixture({ deleteRefFailure: true });
    const result = fixture.run();
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("Failed to delete temporary ref");
    expect(result.stderr).toContain("configured workflow ref deletion failure");
    const deleteCalls = fixture
      .calls()
      .filter((args) => args[0] === "api" && ghApiMethod(args) === "DELETE");
    expect(deleteCalls).toHaveLength(1);
    expect(ghApiEndpoint(deleteCalls[0] ?? [])).toContain("/git/refs/heads/release-ci/");
  });

  it("retries an absent decision artifact through a parent status regression", () => {
    const fixture = createDispatchFixture({
      parentRunStates: [
        { conclusion: null, status: "in_progress", artifactReady: true },
        { conclusion: null, status: "queued" },
        { conclusion: null, status: "in_progress" },
        { conclusion: "success", status: "completed" },
      ],
    });
    const result = fixture.run();
    expect(result.status, result.stderr).toBe(0);
    const calls = fixture.calls();
    const parentPolls = calls
      .map((args, index) => ({ args, index }))
      .filter(({ args }) => ghApiEndpoint(args).endsWith("/actions/runs/123"));
    const artifactDownloads = calls
      .map((args, index) => ({ args, index }))
      .filter(({ args }) => args[0] === "run" && args[1] === "download");
    expect(parentPolls).toHaveLength(6);
    expect(artifactDownloads).toHaveLength(4);
    expect(artifactDownloads[1]?.index).toBeGreaterThan(parentPolls[3]?.index ?? Infinity);
    expect(artifactDownloads[1]?.index).toBeLessThan(parentPolls[4]?.index ?? -Infinity);
    expect(result.stdout).toContain("Parent run status: queued/pending");
    expect(runGit(fixture.origin, ["for-each-ref", "--format=%(refname)", "refs/heads"])).toBe(
      "refs/heads/main\nrefs/heads/release/2026.8.1",
    );
  });

  it("waits for a terminal conclusion across every nonterminal parent state", () => {
    const fixture = createDispatchFixture({
      parentRunStates: [
        { conclusion: null, status: "requested" },
        { conclusion: null, status: "waiting" },
        { conclusion: null, status: "pending" },
        { conclusion: null, status: "completed" },
        { conclusion: "success", status: "completed" },
      ],
    });
    const result = fixture.run();
    expect(result.status, result.stderr).toBe(0);
    const calls = fixture.calls();
    expect(calls.filter((args) => ghApiEndpoint(args).endsWith("/actions/runs/123"))).toHaveLength(
      7,
    );
    expect(calls.filter((args) => args[0] === "run" && args[1] === "download")).toHaveLength(2);
  });

  it("observes a validated blocker promptly while leaving diagnostic drain and refs intact", () => {
    const fixture = createDispatchFixture({
      parentRunStates: [
        { conclusion: null, status: "in_progress" },
        {
          conclusion: null,
          status: "in_progress",
          artifactReady: true,
          decisionState: "blocked_diagnostics_running",
        },
      ],
    });
    const result = fixture.run();
    expect(result.status, result.stderr).toBe(1);
    expect(result.stderr).toContain("blocked_diagnostics_running");
    expect(fixture.readWaits()).toEqual([120_000]);
    const calls = fixture.calls();
    expect(calls.filter((args) => args[0] === "run" && args[1] === "download")).toHaveLength(1);
    expect(calls.some((args) => args.includes("cancel") || args.includes("watch"))).toBe(false);
    expect(fixture.refs()).toHaveLength(1);
  });

  it("does not redownload a validated decision or adopt a newer parent attempt", () => {
    const fixture = createDispatchFixture({
      parentRunStates: [
        { conclusion: null, status: "in_progress", artifactReady: true, decisionState: "passed" },
        { conclusion: null, status: "in_progress", artifactReady: true, decisionState: "passed" },
        { conclusion: null, status: "queued", attempt: 2 },
        { conclusion: null, status: "in_progress", attempt: 2, artifactReady: true },
        {
          conclusion: null,
          status: "queued",
          attempt: 2,
          decisionState: "blocked_diagnostics_running",
        },
      ],
    });
    const result = fixture.run();
    expect(result.status, result.stderr).toBe(1);
    expect(result.stderr).toContain(
      "does not match the exact retained workflow/ref/event/attempt identity",
    );
    expect(fixture.readWaits()).toEqual([120_000, 120_000]);
    const downloads = fixture.calls().filter((args) => args[0] === "run" && args[1] === "download");
    expect(downloads.map((args) => args[args.indexOf("--name") + 1])).toEqual([
      "full-release-decision-123-1",
    ]);
    expect(fixture.record().run).toEqual({
      id: 123,
      attempt: 1,
    });
  });

  it("keeps progress reads sparse while checking unpublished decision metadata", () => {
    const fixture = createDispatchFixture({
      parentRunStates: [
        ...Array.from({ length: 10 }, () => ({ conclusion: null, status: "in_progress" })),
        { conclusion: "success", status: "completed" },
      ],
    });
    const result = fixture.run();
    expect(result.status, result.stderr).toBe(0);
    const calls = fixture.calls();
    expect(calls.filter((args) => args[0] === "run" && args[1] === "download")).toHaveLength(1);
    expect(calls.filter((args) => ghApiEndpoint(args).endsWith("/jobs"))).toHaveLength(1);
    expect(calls.filter((args) => ghApiEndpoint(args).endsWith("/artifacts"))).toHaveLength(11);
    expect(fixture.readWaits()).toEqual(Array(10).fill(120_000));
  });

  it.each([
    { label: "wrong name", artifacts: [{ name: "full-release-decision-999-1", expired: false }] },
  ])("does not use $label metadata as a release decision", ({ artifacts }) => {
    const fixture = createDispatchFixture({
      parentRunStates: [
        {
          conclusion: null,
          status: "in_progress",
          artifacts,
          decisionState: "blocked_diagnostics_running",
        },
        { conclusion: "failure", status: "completed", decisionState: "blocked_complete" },
      ],
    });
    const result = fixture.run();
    expect(result.status, result.stderr).toBe(1);
    expect(result.stderr).toContain("blocked_complete");
    expect(fixture.readWaits()).toEqual([120_000]);
    const downloads = fixture.calls().filter((args) => args[0] === "run" && args[1] === "download");
    expect(downloads).toHaveLength(1);
  });

  it("rejects a downloaded decision from another attempt despite ready metadata", () => {
    const fixture = createDispatchFixture({
      parentRunStates: [
        {
          conclusion: null,
          status: "in_progress",
          artifactReady: true,
          decisionState: "passed",
          decisionAttempt: 2,
        },
      ],
    });
    const result = fixture.run();
    expect(result.status, result.stderr).toBe(1);
    expect(result.stderr).toContain("binding is invalid");
    expect(fixture.readWaits()).toEqual([]);
    expect(fixture.refs()).toHaveLength(1);
  });

  it("dispatches non-main tooling only when its exact protected tag is supplied", () => {
    const fixture = createDispatchFixture();
    const result = fixture.run(["--trusted-workflow-ref", fixture.trustedWorkflowTag]);
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain(`Trusted workflow ref: ${fixture.trustedWorkflowTag}`);
    expect(fixture.gitCalls()).toContainEqual([
      "ls-remote",
      "--tags",
      "origin",
      `refs/tags/${fixture.trustedWorkflowTag}`,
    ]);
    const trustedIdentity = fixture.readPayload().body.inputs.trusted_workflow_json;
    expect(JSON.parse(trustedIdentity ?? "{}").trustedWorkflow).toEqual({
      ref: fixture.trustedWorkflowTag,
      fullRef: `refs/tags/${fixture.trustedWorkflowTag}`,
      sha: fixture.workflowSha,
    });
  });

  it("rejects a fresh request on pre-source contract 1 tooling without upgrading its frozen SHA", () => {
    const fixture = createDispatchFixture({ workflowSource: CONTRACT_ONE_WORKFLOW_SOURCE });
    const result = fixture.run(["--trusted-workflow-ref", fixture.trustedWorkflowTag]);
    expect(result.status, result.stderr).toBe(1);
    expect(result.stderr).toContain("does not support source admission");
    expect(fixture.calls().filter((args) => ghApiMethod(args) !== "GET")).toEqual([]);
  });

  it.each(["publish", "diagnostic"])(
    "requires registry capability only for fresh publish requests: %s",
    (purpose) => {
      const fixture = createDispatchFixture({
        workflowSource: CURRENT_WORKFLOW_SOURCE.replace(
          '  FULL_RELEASE_PUBLICATION_ADMISSION_CONTRACT: "1"\n',
          "",
        ),
      });
      const result = fixture.run([
        "--trusted-workflow-ref",
        fixture.trustedWorkflowTag,
        "-f",
        `validation_purpose=${purpose}`,
        ...(purpose === "publish"
          ? [
              "-f",
              `publication_selection_json=${JSON.stringify({
                route: "normal",
                npmDistTag: "beta",
                publishOpenclawNpm: true,
                pluginPublishScope: "all-publishable",
                plugins: [],
              })}`,
            ]
          : []),
      ]);
      expect(result.status, result.stderr).toBe(purpose === "publish" ? 1 : 0);
      if (purpose === "publish") {
        expect(result.stderr).toContain("does not support registry admission");
        expect(fixture.calls().filter((args) => ghApiMethod(args) !== "GET")).toEqual([]);
        expect(fixture.gitCalls().filter((args) => args[0] === "push")).toEqual([]);
        expect(existsSync(join(fixture.checkout, ".artifacts/full-release-validation"))).toBe(
          false,
        );
      }
    },
  );

  it("fails clearly before dispatch when the target SHA is absent after the named fetch", () => {
    const fixture = createDispatchFixture();
    const missingSha = "f".repeat(40);
    const result = fixture.run(["--sha", missingSha]);
    expect(result.status).toBe(1);
    const failedReasons = result.stderr
      .trim()
      .split("\n")
      .filter((line) => line.startsWith("[full-release-validation] FAILED:"));
    expect(failedReasons).toEqual([
      `[full-release-validation] FAILED: Target SHA ${missingSha} is not available locally after fetching ${fixture.releaseRef}`,
    ]);
    expect(result.stderr.trim().split("\n").at(-1)).toBe(
      "[full-release-validation] FAILED (exit 1)",
    );
    expect(readFileSync(fixture.ghCallsPath, "utf8")).toBe("");
  });

  it("supports current and legacy verifier locations in trusted workflow checkouts", () => {
    const root = mkdtempSync(join(tmpdir(), "openclaw-release-verifier-path-"));
    try {
      const legacy = join(
        root,
        ".agents",
        "skills",
        "release-openclaw-ci",
        "scripts",
        "release-ci-summary.mjs",
      );
      mkdirSync(join(legacy, ".."), { recursive: true });
      writeFileSync(legacy, "");
      expect(releaseEvidenceVerifierPath(root)).toBe(legacy);

      const current = join(root, "scripts", "release-ci-summary.mjs");
      mkdirSync(join(current, ".."), { recursive: true });
      writeFileSync(current, "");
      expect(releaseEvidenceVerifierPath(root)).toBe(current);
    } finally {
      rmSync(root, { force: true, recursive: true });
    }
  });
});
