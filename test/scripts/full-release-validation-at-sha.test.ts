import { execFileSync, spawnSync } from "node:child_process";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { parse as parseYaml } from "yaml";
import {
  assertTrustedWorkflowHarness,
  dispatchInputsDigest,
  FULL_RELEASE_GITHUB_POLL_INTERVAL_MS,
  FULL_RELEASE_WAIT_TIMEOUT_MINUTES,
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
import { resolveReleaseContextIdentity } from "../../scripts/lib/release-context.mjs";

const SCRIPT_PATH = resolve("scripts/full-release-validation-at-sha.mjs");
const CURRENT_WORKFLOW_SOURCE = readFileSync(
  ".github/workflows/full-release-validation.yml",
  "utf8",
);
const CONTRACT_ONE_WORKFLOW_SOURCE = CURRENT_WORKFLOW_SOURCE.replace(
  'RELEASE_ISOLATION_TOOLING_CONTRACT: "2"',
  'RELEASE_ISOLATION_TOOLING_CONTRACT: "1"',
).replace(
  `      trusted_workflow_json:
        description: Trusted release tooling identity JSON
        required: false
        default: ""
        type: string
`,
  "",
);
const LEGACY_WORKFLOW_SOURCE = `name: Full Release Validation
on:
  workflow_dispatch:
    inputs:
      expected_sha:
        required: false
`;

function runGit(cwd: string, args: string[]): string {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  }).trim();
}

function createDispatchFixture(
  options: {
    createRefFailure?: "target" | "workflow";
    deleteRefFailures?: Array<"target" | "workflow">;
    dispatchFailure?: boolean;
    acceptedDispatchFailure?: boolean;
    dispatchReturnsRunUrl?: boolean;
    duplicateRuns?: boolean;
    duplicateOnSecondPage?: boolean;
    runIdentityOverrides?: Record<string, unknown>;
    runPathStyle?: "bare" | "short-ref" | "full-ref";
    witnessOverrides?: Record<string, unknown>;
    witnessInputs?: Record<string, unknown>;
    witnessMissing?: boolean;
    witnessDuplicate?: boolean;
    ghRoute?: "path" | "explicit";
    tokenPresent?: boolean;
    artifactMetadata?: Record<string, unknown>;
    exactArtifactMetadata?: Record<string, unknown>;
    artifactReadError?: "metadata" | "archive";
    oversizedArtifactMetadata?: boolean;
    archiveFailure?: "oversized" | "truncated" | "corrupt" | "digest";
    inventoryError?: string;
    malformedInventory?: boolean;
    incompletePagination?: boolean;
    dispatchHttpStatus?: number;
    failIntentWrite?: boolean;
    stopBeforeDispatch?: boolean;
    reopenDuringDispatch?: boolean;
    parentRunStates?: Array<{
      conclusion: string | null;
      status: string;
      attempt?: number;
      artifactReady?: boolean;
      artifacts?: unknown;
      metadataError?: string;
      decisionState?: string;
      decisionAttempt?: number;
    }>;
    runDiscoveryMisses?: number;
    targetAlreadyRemote?: boolean;
    includeTargetRef?: boolean;
    releaseRef?: string;
    workflowSource?: string;
    targetSource?: Record<string, string>;
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
  const acceptedRunPath = join(root, "accepted-run.json");
  const artifactFixturePath = join(root, "artifact-fixture.cjs");
  const fetchCallsPath = join(root, "fetch-calls.txt");
  const artifactTransportPath = join(root, "artifact-transport.jsonl");
  const preloadPath = join(root, "immediate-poll.mjs");
  const waitCallsPath = join(root, "wait-calls.txt");
  const releaseRef = options.releaseRef ?? "release/2026.8.1";
  mkdirSync(checkout);
  mkdirSync(binDir);
  writeFileSync(gitCallsPath, "");
  writeFileSync(ghCallsPath, "");
  writeFileSync(pathGhCallsPath, "");
  writeFileSync(parentRunIndexPath, "-2");
  writeFileSync(runDiscoveryIndexPath, "0");
  writeFileSync(waitCallsPath, "");
  writeFileSync(fetchCallsPath, "");
  writeFileSync(artifactTransportPath, "");
  writeFileSync(
    preloadPath,
    `import { appendFileSync } from "node:fs";
import fs from "node:fs";
import childProcess from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
const write = fs.writeFileSync;
fs.writeFileSync = (path, data, ...args) => {
  if (${JSON.stringify(options.failIntentWrite ?? false)} && String(data).includes('"phase":"attempted"')) {
    throw new Error("injected intent write failure");
  }
  return write(path, data, ...args);
};
const execute = childProcess.execFileSync;
childProcess.execFileSync = (file, args, options) => {
  if (${JSON.stringify(options.stopBeforeDispatch ?? false)} && args?.some((arg) => arg.endsWith("/dispatches"))) {
    process.exit(77);
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

  execFileSync("git", ["init", "--bare", origin], { stdio: "ignore" });
  execFileSync("git", ["init", "-b", "main"], { cwd: checkout, stdio: "ignore" });
  runGit(checkout, ["config", "user.email", "release-test@openclaw.invalid"]);
  runGit(checkout, ["config", "user.name", "OpenClaw Release Test"]);
  mkdirSync(join(checkout, ".github", "workflows"), { recursive: true });
  mkdirSync(join(checkout, "scripts"), { recursive: true });
  writeFileSync(join(checkout, "package.json"), '{"version":"2026.7.9"}\n');
  writeFileSync(
    join(checkout, "CHANGELOG.md"),
    "## 2026.8.1\n\nRelease notes for the complete selected candidate and its user-facing fixes.\n",
  );
  writeFileSync(
    join(checkout, ".github", "workflows", "full-release-validation.yml"),
    LEGACY_WORKFLOW_SOURCE,
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
  runGit(checkout, ["commit", "-m", "test: legacy workflow"]);
  const oldWorkflowSha = runGit(checkout, ["rev-parse", "HEAD"]);
  writeFileSync(
    join(checkout, ".github", "workflows", "full-release-validation.yml"),
    options.workflowSource ?? CURRENT_WORKFLOW_SOURCE,
  );
  const workflow = parseYaml(
    readFileSync(join(checkout, ".github", "workflows", "full-release-validation.yml"), "utf8"),
  ) as {
    on?: { workflow_dispatch?: { inputs?: Record<string, unknown> } };
  };
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
    ...${JSON.stringify(options.witnessOverrides ?? {})},
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
  writeFileSync(join(checkout, "package.json"), '{"version":"2026.8.1"}\n');
  runGit(checkout, ["add", ".github/workflows/full-release-validation.yml", "package.json"]);
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

  const gitPath = join(binDir, "git");
  writeFileSync(
    gitPath,
    `#!${process.execPath}
const fs = require("node:fs");
const { spawnSync } = require("node:child_process");
const args = process.argv.slice(2);
fs.appendFileSync(process.env.MOCK_GIT_CALLS, JSON.stringify(args) + "\\n");
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
    `#!${process.execPath}
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
    `#!${process.execPath}
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
      ${JSON.stringify(options.runPathStyle ?? "bare")} === "short-ref" ? "@" + accepted.ref
      : ${JSON.stringify(options.runPathStyle ?? "bare")} === "full-ref" ? "@refs/heads/" + accepted.ref : ""
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
  const kind = ref.includes("/validation/") ? "target" : "workflow";
  if (kind === ${JSON.stringify(options.createRefFailure ?? "")}) {
    console.error("configured " + kind + " ref creation failure");
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
  const kind = ref.includes("/validation/") ? "target" : "workflow";
  if (${JSON.stringify(options.deleteRefFailures ?? [])}.includes(kind)) {
    console.error("configured " + kind + " ref deletion failure");
    process.exit(20);
  }
  const result = spawnSync("git", ["--git-dir", process.env.MOCK_ORIGIN, "update-ref", "-d", ref], {
    env: { ...process.env, PATH: process.env.MOCK_REAL_PATH },
    stdio: "inherit",
  });
  process.exit(result.status ?? 1);
} else if ((args[0] === "workflow" && args[1] === "run") || (method === "POST" && endpoint.endsWith("/dispatches"))) {
  const wireInputs = Object.fromEntries(args[0] === "workflow" ? fields : [...fields]
    .filter(([key]) => key.startsWith("inputs[")).map(([key, value]) => [key.slice(7, -1), value]));
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
    typedInputs: Object.fromEntries(Object.entries(wireInputs).map(([key, value]) => [
      key, JSON.parse(process.env.MOCK_WORKFLOW_SCHEMA)[key].type === "boolean" ? value === "true" : value,
    ])),
    ref: args[0] === "workflow" ? args[args.indexOf("--ref") + 1] : fields.get("ref"),
  }));
  if (${JSON.stringify(options.acceptedDispatchFailure ?? false)}) {
    console.error("connection reset by peer after server acceptance");
    process.exit(1);
  }
  if (args[0] === "api") {
    console.log("HTTP/2.0 204 No Content\\r\\nContent-Length: 0\\r\\n\\r\\n");
  } else if (${JSON.stringify(options.dispatchReturnsRunUrl ?? true)}) {
    console.log("https://github.com/openclaw/openclaw/actions/runs/123");
  }
} else if (args[0] === "api" && endpoint.endsWith("/actions/workflows/full-release-validation.yml")) {
  console.log(JSON.stringify({ id: 17, path: ".github/workflows/full-release-validation.yml" }));
} else if (args[0] === "api" && /\\/actions\\/workflows\\/(?:17|full-release-validation.yml)\\/runs$/.test(endpoint)) {
  if (${JSON.stringify(options.inventoryError ?? "")}) {
    console.error(${JSON.stringify(options.inventoryError ?? "")});
    process.exit(1);
  }
  const index = Number(fs.readFileSync(runDiscoveryIndexPath, "utf8"));
  fs.writeFileSync(runDiscoveryIndexPath, String(index + 1));
  const ids = ${JSON.stringify(options.duplicateOnSecondPage ?? false)} ? Array.from({ length: 21 }, (_, i) => 123 + i)
    : ${JSON.stringify(options.duplicateRuns ?? false)} ? [123, 124] : [123];
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
  console.log(${JSON.stringify(options.malformedInventory ?? false)} ? "{" : JSON.stringify({ total_count: runs.length, workflow_runs: runs.slice((page - 1) * 20, page * 20) }));
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
    if (failure === "truncated") bytes = bytes.subarray(0, bytes.length - 1);
    if (failure === "digest") bytes[0] ^= 1;
    process.stdout.write(bytes);
  });
} else if (args[0] === "api" && endpoint.endsWith("/artifacts") && (fields.get("name") || "").startsWith("full-release-dispatch-inputs-")) {
  require(${JSON.stringify(artifactFixturePath)})().then(({ metadata }) => {
    const artifacts = ${JSON.stringify(options.witnessMissing ?? false)} ? []
      : ${JSON.stringify(options.witnessDuplicate ?? false)} ? [metadata, metadata] : [metadata];
    console.log(JSON.stringify({ total_count: artifacts.length, artifacts }));
  });
} else if (args[0] === "api" && endpoint.endsWith("/artifacts")) {
  const index = Number(fs.readFileSync(parentRunIndexPath, "utf8")) - 1;
  const state = parentRunStates[index];
  if (state.metadataError) {
    console.error(state.metadataError);
    process.exit(1);
  }
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
      process.execPath,
      [
        SCRIPT_PATH,
        ...(recoveryOnly
          ? []
          : [
              "--sha",
              targetSha,
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
          MOCK_WORKFLOW_SCHEMA: JSON.stringify(workflow.on?.workflow_dispatch?.inputs),
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

  return {
    checkout,
    acceptedRunPath,
    artifactTransportPath,
    cleanup: () => rmSync(root, { force: true, recursive: true }),
    ghCallsPath,
    fetchCallsPath,
    gitCallsPath,
    origin,
    oldWorkflowSha,
    pathGhCallsPath,
    readCalls,
    readWaits,
    requestPath: () => {
      const directory = join(checkout, ".artifacts", "full-release-validation");
      return join(
        directory,
        readdirSync(directory).find((name) => name.endsWith(".json"))!,
      );
    },
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

function dispatchedInputs(args: string[]): Record<string, string> {
  return Object.fromEntries(
    args.flatMap((argument, index) => {
      if (args[index - 1] !== "-f") {
        return [];
      }
      const assignment = /^inputs\[([^\]]+)\]=([\s\S]*)$/u.exec(argument);
      return assignment ? [[assignment[1], assignment[2]]] : [];
    }),
  );
}

describe("full-release-validation-at-sha", () => {
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
    expect(releaseProfileForTarget("a".repeat(40), readVersion("2026.7.1-alpha.4"))).toBe("beta");
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

  it.each([
    ["release/2026.7.1", "2026.7.1-beta.5", "v2026.7.1-beta.5", null],
    ["release/2026.7.1-2", "2026.7.1", "v2026.7.1-2", "v2026.7.1"],
    ["release/2026.7.1-2", "2026.7.1-2", "v2026.7.1-2", null],
    ["v2026.7.1-2", "2026.7.1", "v2026.7.1-2", "v2026.7.1"],
    ["v2026.7.1-2", "2026.7.1-2", "v2026.7.1-2", null],
    ["extended-stable/2026.6.33", "2026.6.35", "v2026.6.35", null],
  ] as const)(
    "resolves publication identity for %s without changing package %s",
    (ref, packageVersion, releaseTag, baseTag) => {
      expect(resolveReleaseContextIdentity(ref, packageVersion)).toMatchObject({
        releaseTag,
        baseTag,
      });
    },
  );

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
    expect(
      verifyTargetRef(
        "release/2026.7.1",
        candidateSha,
        "2026.7.1-beta.5",
        () => branchTipSha,
        (ancestor, descendant) => ancestor === candidateSha && descendant === branchTipSha,
      ),
    ).toBe("release/2026.7.1");
    expect(() =>
      verifyTargetRef(
        "release/2026.7.1",
        candidateSha,
        "2026.7.1-alpha.5",
        () => branchTipSha,
        () => true,
      ),
    ).toThrow("expected 2026.7.1 or a beta prerelease of it");
    expect(() =>
      verifyTargetRef(
        "release/2026.7.1",
        candidateSha,
        "2026.7.1",
        () => branchTipSha,
        () => false,
      ),
    ).toThrow("is not reachable from release branch");
    expect(() =>
      verifyTargetRef(
        "release/2026.7.1",
        candidateSha,
        "2026.6.9",
        () => branchTipSha,
        () => true,
      ),
    ).toThrow("does not belong to release branch");
    for (const version of ["2026.6.33", "2026.6.34", "2026.6.35"]) {
      expect(
        verifyTargetRef(
          "extended-stable/2026.6.33",
          candidateSha,
          version,
          () => branchTipSha,
          () => true,
        ),
      ).toBe("extended-stable/2026.6.33");
    }
    for (const version of ["2026.6.32", "2026.7.35", "2026.6.35-beta.1", "2026.6.35-1"]) {
      expect(() =>
        verifyTargetRef(
          "extended-stable/2026.6.33",
          candidateSha,
          version,
          () => branchTipSha,
          () => true,
        ),
      ).toThrow("does not belong to extended-stable branch");
    }
    expect(
      verifyTargetRef(
        "v2026.7.1-beta.5",
        candidateSha,
        "2026.7.1-beta.5",
        () => candidateSha,
        () => false,
      ),
    ).toBe("v2026.7.1-beta.5");
    expect(() =>
      verifyTargetRef(
        "v2026.7.1-beta.5",
        candidateSha,
        "2026.7.1-beta.5",
        () => branchTipSha,
        () => true,
      ),
    ).toThrow("does not resolve");
    expect(() =>
      verifyTargetRef(
        "v2026.7.1-beta.5",
        candidateSha,
        "2026.7.1-beta.4",
        () => candidateSha,
        () => true,
      ),
    ).toThrow("does not match release tag");
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
    const workflowSha = "a".repeat(40);
    const trustedTag = `release-publish/${workflowSha.slice(0, 12)}-123`;

    expect(() =>
      verifyTrustedWorkflowRef(
        workflowSha,
        "main",
        () => "",
        () => true,
      ),
    ).not.toThrow();
    expect(() =>
      verifyTrustedWorkflowRef(
        workflowSha,
        "main",
        () => "",
        () => false,
      ),
    ).toThrow("not reachable from current origin/main");
    expect(() =>
      verifyTrustedWorkflowRef(
        workflowSha,
        trustedTag,
        () => workflowSha,
        () => false,
      ),
    ).not.toThrow();
    expect(() =>
      verifyTrustedWorkflowRef(
        workflowSha,
        `release-publish/${"b".repeat(12)}-123`,
        () => workflowSha,
      ),
    ).toThrow("does not match Tooling SHA");
    expect(() => verifyTrustedWorkflowRef(workflowSha, trustedTag, () => "")).toThrow(
      "does not exist on origin",
    );
    expect(() => verifyTrustedWorkflowRef(workflowSha, trustedTag, () => "c".repeat(40))).toThrow(
      `expected ${workflowSha}`,
    );
    expect(() =>
      verifyTrustedWorkflowRef(workflowSha, "release/2026.8.1", () => workflowSha),
    ).toThrow("protected release-publish");
  });

  it("bounds polling for the exact workflow run", () => {
    const source = readFileSync("scripts/full-release-validation-at-sha.mts", "utf8");
    expect(FULL_RELEASE_WAIT_TIMEOUT_MINUTES).toBe(720);
    expect(FULL_RELEASE_GITHUB_POLL_INTERVAL_MS).toBe(120_000);
    expect(source).toContain("workflowRun.head_sha !== workflowSha");
    expect(source).toContain("return suite;");
    expect(source).toContain("startedAt + FULL_RELEASE_WAIT_TIMEOUT_MINUTES * 60_000");
    expect(source).toContain("const remainingMs = deadline - Date.now();");
    expect(source).toContain("Math.min(FULL_RELEASE_GITHUB_POLL_INTERVAL_MS, remainingMs)");
    expect(source).toContain("Parent run progress after ${elapsedMinutes}m");
    expect(source).toContain("formatReleaseStateOutcome(releaseDecision)");
    expect(source).toContain(
      "Timed out after ${FULL_RELEASE_WAIT_TIMEOUT_MINUTES} minutes waiting for Full Release Validation",
    );
    expect(source).not.toContain("attempt < 480");
  });

  it("discovers the run promptly and observes completion within two minutes", () => {
    const fixture = createDispatchFixture({
      dispatchReturnsRunUrl: false,
      parentRunStates: [
        { conclusion: null, status: "in_progress" },
        { conclusion: "success", status: "completed" },
      ],
      runDiscoveryMisses: 1,
    });
    try {
      const result = fixture.run(["--workflow-sha", fixture.workflowSha]);
      expect(result.status, result.stderr).toBe(0);
      expect(fixture.readWaits()).toEqual([30_000, 120_000]);
      const calls = fixture.readCalls(fixture.ghCallsPath);
      expect(
        calls.filter((args) => ghApiEndpoint(args).endsWith("/actions/workflows/17/runs")),
      ).toHaveLength(3);
      expect(
        calls.filter((args) => ghApiEndpoint(args).endsWith("/actions/runs/123")),
      ).toHaveLength(4);
    } finally {
      fixture.cleanup();
    }
  });

  it("bounds run discovery with backoff through cached registration lag", () => {
    const fixture = createDispatchFixture({
      dispatchReturnsRunUrl: false,
      runDiscoveryMisses: 4,
    });
    try {
      const result = fixture.run(["--workflow-sha", fixture.workflowSha]);
      expect(result.status).toBe(1);
      expect(result.stderr).toContain("Could not determine Full Release Validation run id:");
      expect(fixture.readWaits()).toEqual([30_000, 60_000, 120_000]);
      const calls = fixture.readCalls(fixture.ghCallsPath);
      expect(
        calls.filter((args) => ghApiEndpoint(args).endsWith("/actions/workflows/17/runs")),
      ).toHaveLength(4);
    } finally {
      fixture.cleanup();
    }
  });

  it("reconciles an accepted dispatch after its response is lost without another POST", () => {
    const fixture = createDispatchFixture({ acceptedDispatchFailure: true });
    try {
      const result = fixture.run(["--workflow-sha", fixture.workflowSha]);
      expect(JSON.parse(readFileSync(fixture.acceptedRunPath, "utf8")).inputs.ref).toBe(
        fixture.targetSha,
      );
      expect(result.status, result.stderr).toBe(0);
      expect(result.stdout).toContain(
        "Parent run: https://github.com/openclaw/openclaw/actions/runs/123",
      );
      expect(fixture.readCalls(fixture.ghCallsPath).filter(isWorkflowDispatch)).toHaveLength(1);
    } finally {
      fixture.cleanup();
    }
  });

  it("leaves duplicate exact dispatch runs unresolved instead of adopting the first", () => {
    const fixture = createDispatchFixture({ duplicateRuns: true, dispatchReturnsRunUrl: false });
    try {
      const result = fixture.run(["--workflow-sha", fixture.workflowSha]);
      expect(result.status, result.stdout).toBe(1);
      expect(result.stdout).not.toContain("ok release evidence");
      expect(
        fixture.readCalls(fixture.ghCallsPath).filter((args) => ghApiMethod(args) === "DELETE"),
      ).toEqual([]);
    } finally {
      fixture.cleanup();
    }
  });

  it("does not adopt a returned run URL when its workflow event is unrelated", () => {
    const fixture = createDispatchFixture({ runIdentityOverrides: { event: "push" } });
    try {
      const result = fixture.run(["--workflow-sha", fixture.workflowSha]);
      expect(result.status, result.stdout).toBe(1);
      expect(result.stdout).not.toContain("ok release evidence");
      expect(
        fixture.readCalls(fixture.ghCallsPath).filter((args) => ghApiMethod(args) === "DELETE"),
      ).toEqual([]);
    } finally {
      fixture.cleanup();
    }
  });

  it.each([false, true])(
    "reopens the same retained request without mutations (explicit=%s)",
    (explicit) => {
      const fixture = createDispatchFixture({ acceptedDispatchFailure: true });
      try {
        expect(fixture.run(["--workflow-sha", fixture.workflowSha]).status).toBe(0);
        const path = fixture.requestPath();
        const before = readFileSync(path, "utf8");
        const priorGh = fixture.readCalls(fixture.ghCallsPath).length;
        const priorGit = fixture.readCalls(fixture.gitCallsPath).length;
        const result = fixture.run(
          explicit ? ["--reconcile-request", path] : ["--request-file", path],
          true,
        );
        expect(result.status, result.stderr).toBe(0);
        expect(result.stdout).toContain(
          "dispatch=observed: https://github.com/openclaw/openclaw/actions/runs/123 attempt=1",
        );
        expect(readFileSync(path, "utf8")).toBe(before);
        expect(statSync(path).mode & 0o777).toBe(0o600);
        expect(fixture.readCalls(fixture.gitCallsPath)).toHaveLength(priorGit);
        expect(
          fixture
            .readCalls(fixture.ghCallsPath)
            .slice(priorGh)
            .every((args) => args[0] === "api" && ghApiMethod(args) === "GET"),
        ).toBe(true);
      } finally {
        fixture.cleanup();
      }
    },
  );

  it("refuses conflicting reopen inputs without consulting or mutating GitHub", () => {
    const fixture = createDispatchFixture();
    try {
      expect(fixture.run(["--workflow-sha", fixture.workflowSha]).status).toBe(0);
      const path = fixture.requestPath();
      const calls = readFileSync(fixture.ghCallsPath, "utf8");
      const gitCalls = readFileSync(fixture.gitCallsPath, "utf8");
      const result = fixture.run(["--request-file", path, "-f", "provider=anthropic"], true);
      expect(result.status).toBe(1);
      expect(result.stderr).toContain("conflict with the retained request");
      expect(readFileSync(fixture.ghCallsPath, "utf8")).toBe(calls);
      expect(readFileSync(fixture.gitCallsPath, "utf8")).toBe(gitCalls);
    } finally {
      fixture.cleanup();
    }
  });

  it.each(["missing", "truncated", "oversized", "symlink", "parent symlink", "public"] as const)(
    "refuses a %s request before any remote or Git access",
    (kind) => {
      const fixture = createDispatchFixture();
      try {
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
        expect(fixture.readCalls(fixture.ghCallsPath)).toEqual([]);
        expect(fixture.readCalls(fixture.gitCallsPath)).toEqual([]);
      } finally {
        fixture.cleanup();
      }
    },
  );

  it.each([false, true])(
    "refuses witness-incapable frozen tooling before remote creation (contract1=%s)",
    (contractOne) => {
      const fixture = createDispatchFixture({
        workflowSource: (contractOne
          ? CONTRACT_ONE_WORKFLOW_SOURCE
          : CURRENT_WORKFLOW_SOURCE
        ).replace('  FULL_RELEASE_DISPATCH_WITNESS_CONTRACT: "1"\n', ""),
      });
      try {
        const result = fixture.run(["--workflow-sha", fixture.workflowSha]);
        expect(result.status).toBe(1);
        expect(result.stderr).toContain(
          `Tooling SHA ${fixture.workflowSha} does not support FULL_RELEASE_DISPATCH_WITNESS_CONTRACT=1`,
        );
        expect(fixture.readCalls(fixture.ghCallsPath)).toEqual([]);
        expect(fixture.readCalls(fixture.gitCallsPath).some((args) => args[0] === "push")).toBe(
          false,
        );
        expect(
          runGit(fixture.origin, [
            "for-each-ref",
            "--format=%(refname)",
            "refs/heads/release-ci",
            "refs/heads/validation",
          ]),
        ).toBe("");
      } finally {
        fixture.cleanup();
      }
    },
  );

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
    try {
      const result = fixture.run(["--workflow-sha", fixture.workflowSha]);
      expect(result.status, result.stderr).toBe(status);
      const path = fixture.requestPath();
      expect(JSON.parse(readFileSync(path, "utf8")).phase).toBe(phase);
      const before = readFileSync(path, "utf8");
      const recovery = fixture.run(["--reconcile-request", path], true);
      expect(recovery.status).toBe(1);
      expect(recovery.stderr).toContain("dispatch=unknown");
      expect(readFileSync(path, "utf8")).toBe(before);
      expect(fixture.readCalls(fixture.ghCallsPath).filter(isWorkflowDispatch)).toEqual([]);
    } finally {
      fixture.cleanup();
    }
  });

  it("allows only the claimed caller to POST when another caller reopens concurrently", () => {
    const fixture = createDispatchFixture({ reopenDuringDispatch: true });
    try {
      const result = fixture.run(["--workflow-sha", fixture.workflowSha]);
      expect(result.status, result.stderr).toBe(0);
      expect(fixture.readCalls(fixture.ghCallsPath).filter(isWorkflowDispatch)).toHaveLength(1);
    } finally {
      fixture.cleanup();
    }
  });

  it.each([
    { ghRoute: "path" as const, tokenPresent: false },
    { ghRoute: "path" as const, tokenPresent: true },
    { ghRoute: "explicit" as const, tokenPresent: true },
  ])(
    "reads witness bytes through $ghRoute CLI without Node fetch (token=$tokenPresent)",
    ({ ghRoute, tokenPresent }) => {
      const fixture = createDispatchFixture({ ghRoute, tokenPresent });
      try {
        const result = fixture.run(["--workflow-sha", fixture.workflowSha]);
        expect(result.status, result.stderr).toBe(0);
        const calls = fixture.readCalls(fixture.ghCallsPath);
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
        expect(fixture.readCalls(fixture.pathGhCallsPath)).toEqual(ghRoute === "path" ? calls : []);
        expect(JSON.parse(readFileSync(fixture.requestPath(), "utf8")).phase).toBe("observed");
      } finally {
        fixture.cleanup();
      }
    },
  );

  it.each([
    { name: "nonpositive ID", artifactMetadata: { id: 0 } },
    { name: "string ID", artifactMetadata: { id: "9001" } },
    { name: "unsafe ID", artifactMetadata: { id: Number.MAX_SAFE_INTEGER + 1 } },
    { name: "zero size", artifactMetadata: { size_in_bytes: 0 } },
    { name: "string size", artifactMetadata: { size_in_bytes: "100" } },
    { name: "oversized declaration", artifactMetadata: { size_in_bytes: 256 * 1024 + 1 } },
    { name: "invalid digest", artifactMetadata: { digest: "sha256:invalid" } },
    { name: "expired flag", artifactMetadata: { expired: true } },
    { name: "elapsed expiry", artifactMetadata: { expires_at: "2000-01-01T00:00:00Z" } },
    { name: "invalid expiry", artifactMetadata: { expires_at: "invalid" } },
    { name: "changed ID", exactArtifactMetadata: { id: 9002 } },
    { name: "changed name", exactArtifactMetadata: { name: "other" } },
    { name: "changed size", exactArtifactMetadata: { size_in_bytes: 1 } },
    { name: "changed digest", exactArtifactMetadata: { digest: `sha256:${"0".repeat(64)}` } },
    { name: "changed expiry", exactArtifactMetadata: { expires_at: "2098-01-01T00:00:00Z" } },
    { name: "newly expired", exactArtifactMetadata: { expired: true } },
    { name: "changed run", exactArtifactMetadata: { workflow_run: { id: 124 } } },
    {
      name: "changed SHA",
      exactArtifactMetadata: { workflow_run: { id: 123, head_sha: "c".repeat(40) } },
    },
    { name: "oversized metadata", oversizedArtifactMetadata: true },
    { name: "denied metadata", artifactReadError: "metadata" as const },
    { name: "denied archive", artifactReadError: "archive" as const },
    { name: "oversized archive", archiveFailure: "oversized" as const },
    { name: "truncated archive", archiveFailure: "truncated" as const },
    { name: "corrupt ZIP with matching digest", archiveFailure: "corrupt" as const },
    { name: "mismatched archive digest", archiveFailure: "digest" as const },
  ])("refuses witness $name without fallback or remote cleanup", ({ name: _name, ...options }) => {
    const fixture = createDispatchFixture({
      ...options,
      ghRoute: "path",
      tokenPresent: false,
    });
    try {
      const result = fixture.run(["--workflow-sha", fixture.workflowSha]);
      expect(result.status, result.stdout).toBe(1);
      expect(result.stderr).toContain("dispatch=unknown");
      expect(result.stdout).not.toContain("ok release evidence");
      const calls = fixture.readCalls(fixture.ghCallsPath);
      expect(calls.filter(isWorkflowDispatch)).toHaveLength(1);
      expect(calls.filter((args) => ghApiMethod(args) === "DELETE")).toEqual([]);
      expect(calls.filter((args) => args[0] === "auth")).toEqual([]);
      expect(readFileSync(fixture.fetchCallsPath, "utf8")).toBe("");
      expect(JSON.parse(readFileSync(fixture.requestPath(), "utf8")).phase).toBe("attempted");
      expect(
        runGit(fixture.origin, [
          "for-each-ref",
          "--format=%(refname)",
          "refs/heads/release-ci",
          "refs/heads/validation",
        ]).split("\n"),
      ).toHaveLength(2);
    } finally {
      fixture.cleanup();
    }
  });

  it.each(["bare", "short-ref", "full-ref"] as const)(
    "accepts the %s exact workflow path representation",
    (runPathStyle) => {
      const fixture = createDispatchFixture({ runPathStyle });
      try {
        const result = fixture.run(["--workflow-sha", fixture.workflowSha]);
        expect(result.status, result.stderr).toBe(0);
        expect(JSON.parse(readFileSync(fixture.requestPath(), "utf8"))).toMatchObject({
          phase: "observed",
          run: { id: 123, attempt: 1 },
        });
        expect(fixture.readCalls(fixture.ghCallsPath).filter(isWorkflowDispatch)).toHaveLength(1);
      } finally {
        fixture.cleanup();
      }
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
    { name: "API denial", options: { inventoryError: "HTTP 403: forbidden" } },
    { name: "API outage", options: { inventoryError: "HTTP 503: unavailable" } },
    { name: "malformed inventory", options: { malformedInventory: true } },
    {
      name: "wrong repository",
      options: { runIdentityOverrides: { repository: { full_name: "example/other" } } },
    },
    { name: "wrong workflow", options: { runIdentityOverrides: { workflow_id: 18 } } },
    {
      name: "wrong path",
      options: { runIdentityOverrides: { path: ".github/workflows/other.yml" } },
    },
    {
      name: "foreign short-ref suffix",
      options: {
        runIdentityOverrides: { path: ".github/workflows/full-release-validation.yml@main" },
      },
    },
    {
      name: "foreign full-ref suffix",
      options: {
        runIdentityOverrides: {
          path: ".github/workflows/full-release-validation.yml@refs/heads/main",
        },
      },
    },
    {
      name: "foreign tag suffix",
      options: {
        runIdentityOverrides: {
          path: ".github/workflows/full-release-validation.yml@refs/tags/main",
        },
      },
    },
    { name: "wrong transport", options: { runIdentityOverrides: { head_branch: "main" } } },
    { name: "wrong tooling SHA", options: { runIdentityOverrides: { head_sha: "c".repeat(40) } } },
    { name: "wrong witness attempt", options: { witnessOverrides: { runAttempt: "2" } } },
  ])("leaves $name unresolved without verification or cleanup", ({ options }) => {
    const fixture = createDispatchFixture(options);
    try {
      const result = fixture.run(["--workflow-sha", fixture.workflowSha]);
      expect(result.status, result.stdout).toBe(1);
      expect(result.stderr).toContain("dispatch=unknown");
      expect(result.stdout).not.toContain("ok release evidence");
      const calls = fixture.readCalls(fixture.ghCallsPath);
      expect(calls.filter(isWorkflowDispatch)).toHaveLength(1);
      expect(calls.filter((args) => ghApiMethod(args) === "DELETE")).toEqual([]);
      if (options.duplicateOnSecondPage && !options.incompletePagination) {
        expect(calls.some((args) => ghField(args, "page") === "2")).toBe(true);
      }
    } finally {
      fixture.cleanup();
    }
  });

  it.each(Object.keys(parseYaml(CURRENT_WORKFLOW_SOURCE).on.workflow_dispatch.inputs))(
    "does not adopt a run with a different %s input witness",
    (key) => {
      const fixture = createDispatchFixture({ witnessInputs: { [key]: "__different_input__" } });
      try {
        const result = fixture.run(["--workflow-sha", fixture.workflowSha]);
        expect(result.status, result.stdout).toBe(1);
        expect(result.stderr).toContain(
          "Dispatch input witness does not match the complete retained request",
        );
        expect(
          fixture.readCalls(fixture.ghCallsPath).filter((args) => ghApiMethod(args) === "DELETE"),
        ).toEqual([]);
      } finally {
        fixture.cleanup();
      }
    },
  );

  it.each([
    ["beta", false],
    ["stable", true],
    ["full", true],
  ] as const)(
    "retains raw defaults separately from effective %s soak",
    (profile, effectiveSoak) => {
      const fixture = createDispatchFixture();
      try {
        const result = fixture.run([
          "--workflow-sha",
          fixture.workflowSha,
          "-f",
          `release_profile=${profile}`,
        ]);
        expect(result.status, result.stderr).toBe(0);
        const record = JSON.parse(readFileSync(fixture.requestPath(), "utf8"));
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
      } finally {
        fixture.cleanup();
      }
    },
  );

  it.each([403, 422])(
    "retains HTTP %s rejection without adopting or redispatching",
    (dispatchHttpStatus) => {
      const fixture = createDispatchFixture({ dispatchHttpStatus });
      try {
        const result = fixture.run(["--workflow-sha", fixture.workflowSha]);
        expect(result.status).toBe(1);
        expect(result.stderr).toContain("dispatch=rejected");
        const path = fixture.requestPath();
        expect(JSON.parse(readFileSync(path, "utf8")).phase).toBe("rejected");
        const calls = readFileSync(fixture.ghCallsPath, "utf8");
        const recovery = fixture.run(["--reconcile-request", path], true);
        expect(recovery.status).toBe(1);
        expect(recovery.stderr).toContain("dispatch=rejected");
        expect(readFileSync(fixture.ghCallsPath, "utf8")).toBe(calls);
      } finally {
        fixture.cleanup();
      }
    },
  );

  it("does not retain or mutate a request in dry-run mode", () => {
    const fixture = createDispatchFixture();
    try {
      const result = fixture.run(["--workflow-sha", fixture.workflowSha, "--dry-run"]);
      expect(result.status, result.stderr).toBe(0);
      expect(result.stdout).toContain("(dry run; not written)");
      expect(fixture.readCalls(fixture.ghCallsPath)).toEqual([]);
      expect(fixture.readCalls(fixture.gitCallsPath).some((args) => args[0] === "push")).toBe(
        false,
      );
    } finally {
      fixture.cleanup();
    }
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

  it.each([
    "no valid artifacts found to download",
    "no artifact matches any of the names provided",
    "no artifact matches any of the names or patterns provided",
  ])("treats missing named Release Decision artifacts as unavailable: %s", (stderr) => {
    expect(
      tryReadReleaseDecision("123", 1, "a".repeat(40), () => ({
        error: undefined,
        signal: null,
        status: 1,
        stderr,
        stdout: "",
      })),
    ).toBeUndefined();
  });

  it("keeps an invalid parent run fatal when artifact lookup returns HTTP 404", () => {
    expect(() =>
      tryReadReleaseDecision("123", 1, "a".repeat(40), () => ({
        error: undefined,
        signal: null,
        status: 1,
        stderr: "error fetching artifacts: HTTP 404: Not Found",
        stdout: "",
      })),
    ).toThrow("Release Decision artifact download failed");
  });

  it("bounds GitHub reads without applying a timeout to workflow dispatch", () => {
    const source = readFileSync("scripts/full-release-validation-at-sha.mts", "utf8");
    expect(source).toContain("timeout: GH_READ_TIMEOUT_MS");
    expect(source).toContain("dispatchOutput = runGh(dispatchArgs");
    expect(source).not.toContain('run("gh"');
  });

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
    expect(
      shouldDeleteTemporaryWorkflowRef({
        dryRun: false,
        evidenceVerified: false,
        keepBranch: false,
        parentConclusion: "failure",
      }),
    ).toBe(false);
    expect(
      shouldDeleteTemporaryWorkflowRef({
        dryRun: false,
        evidenceVerified: true,
        keepBranch: false,
        parentConclusion: "success",
      }),
    ).toBe(true);
    expect(
      shouldDeleteTemporaryWorkflowRef({
        dryRun: true,
        evidenceVerified: false,
        keepBranch: false,
        parentConclusion: "",
      }),
    ).toBe(true);
    expect(
      shouldDeleteTemporaryWorkflowRef({
        dryRun: false,
        evidenceVerified: false,
        keepBranch: false,
        parentConclusion: "success",
      }),
    ).toBe(false);
  });

  it.each<{ name: string; source: Record<string, string>; error: string }>([
    {
      name: "missing version notes",
      source: { "CHANGELOG.md": "## 2026.7.9\n\nAn older release with substantive notes.\n" },
      error: "does not contain a release section for 2026.8.1",
    },
    {
      name: "empty version notes",
      source: { "CHANGELOG.md": "## 2026.8.1\n" },
      error: "below the 32 byte safety minimum",
    },
    {
      name: "misaligned core package",
      source: {
        "package.json": JSON.stringify({
          version: "2026.8.1",
          dependencies: { "@openclaw/ai": "workspace:*" },
        }),
        "packages/ai/package.json": '{"version":"2026.7.9"}',
      },
      error: "packages/ai/package.json version must match package.json",
    },
  ])("rejects $name before creating remote refs or dispatching", ({ source, error }) => {
    const fixture = createDispatchFixture({ targetSource: source });
    try {
      const result = fixture.run(["--workflow-sha", fixture.workflowSha]);
      expect(result.status).toBe(1);
      expect(result.stderr).toContain(error);
      expect(fixture.readCalls(fixture.gitCallsPath).filter((call) => call[0] === "push")).toEqual(
        [],
      );
      const ghCalls = fixture.readCalls(fixture.ghCallsPath);
      expect(ghCalls.filter((call) => call[0] === "api" && ghApiMethod(call) !== "GET")).toEqual(
        [],
      );
      expect(ghCalls.filter(isWorkflowDispatch)).toEqual([]);
    } finally {
      fixture.cleanup();
    }
  });

  it("preserves explicitly allowed substantive draft notes during source admission", () => {
    const fixture = createDispatchFixture({
      targetSource: {
        "CHANGELOG.md":
          "## Unreleased\n\nSubstantive draft notes for the complete selected release candidate.\n",
      },
    });
    try {
      const result = fixture.run([
        "--workflow-sha",
        fixture.workflowSha,
        "-f",
        "allow_unreleased_changelog=true",
      ]);
      expect(result.status, result.stderr).toBe(0);
      expect(fixture.readCalls(fixture.ghCallsPath).some(isWorkflowDispatch)).toBe(true);
    } finally {
      fixture.cleanup();
    }
  });

  it.each([false, true])(
    "dispatches the frozen SHA and context, then cleans transport refs (correction=%s)",
    (correction) => {
      const fixture = createDispatchFixture();
      try {
        const releaseRef = correction ? `${fixture.releaseRef}-2` : fixture.releaseRef;
        if (correction) {
          runGit(fixture.checkout, ["branch", releaseRef, fixture.targetSha]);
          runGit(fixture.checkout, [
            "tag",
            "-a",
            "v2026.8.1",
            fixture.targetSha,
            "-m",
            "base release",
          ]);
          runGit(fixture.checkout, [
            "push",
            "origin",
            `refs/heads/${releaseRef}`,
            "refs/tags/v2026.8.1",
          ]);
          expect(runGit(fixture.origin, ["tag", "--list", "v2026.8.1-2"])).toBe("");
        }
        const result = fixture.run([
          "--workflow-sha",
          fixture.workflowSha,
          "--target-ref",
          releaseRef,
        ]);
        expect(result.status, result.stderr).toBe(0);
        const gitCalls = fixture.readCalls(fixture.gitCallsPath);
        const ghCalls = fixture.readCalls(fixture.ghCallsPath);
        const createCalls = ghCalls.filter(
          (args) =>
            args[0] === "api" &&
            ghApiMethod(args) === "POST" &&
            ghApiEndpoint(args).endsWith("/git/refs"),
        );
        const targetCreate = createCalls.find((args) =>
          ghField(args, "ref").startsWith("refs/heads/validation/target-"),
        );
        expect(ghField(targetCreate ?? [], "ref")).toMatch(
          new RegExp(
            `^refs/heads/validation/target-${fixture.targetSha.slice(0, 12)}-[0-9]+$`,
            "u",
          ),
        );
        expect(ghField(targetCreate ?? [], "sha")).toBe(fixture.targetSha);
        const targetBranch = ghField(targetCreate ?? [], "ref").slice("refs/heads/".length);
        const workflowCreate = createCalls.find((args) =>
          ghField(args, "ref").startsWith("refs/heads/release-ci/"),
        );
        const workflowBranch = ghField(workflowCreate ?? [], "ref").slice("refs/heads/".length);
        expect(ghField(workflowCreate ?? [], "ref")).toMatch(
          new RegExp(`^refs/heads/release-ci/${fixture.workflowSha.slice(0, 12)}-[0-9]+$`, "u"),
        );
        expect(ghField(workflowCreate ?? [], "sha")).toBe(fixture.workflowSha);
        expect(createCalls).toEqual([
          [
            "api",
            "--method",
            "POST",
            "repos/openclaw/openclaw/git/refs",
            "-f",
            `ref=refs/heads/${targetBranch}`,
            "-f",
            `sha=${fixture.targetSha}`,
            "--hostname",
            "github.com",
          ],
          [
            "api",
            "--method",
            "POST",
            "repos/openclaw/openclaw/git/refs",
            "-f",
            `ref=refs/heads/${workflowBranch}`,
            "-f",
            `sha=${fixture.workflowSha}`,
            "--hostname",
            "github.com",
          ],
        ]);
        const dispatch = ghCalls.find(isWorkflowDispatch) ?? [];
        expect(ghApiMethod(dispatch)).toBe("POST");
        expect(ghApiEndpoint(dispatch)).toBe(
          "repos/openclaw/openclaw/actions/workflows/full-release-validation.yml/dispatches",
        );
        expect(ghField(dispatch, "ref")).toBe(workflowBranch);
        const dispatchInputs = dispatchedInputs(dispatch);
        expect(dispatchInputs).toMatchObject({
          ref: fixture.targetSha,
          expected_sha: fixture.targetSha,
          target_context_ref: releaseRef,
          allow_unreleased_changelog: "false",
        });
        expect(JSON.parse(dispatchInputs.trusted_workflow_json ?? "{}")).toEqual({
          ref: "main",
          fullRef: "refs/heads/main",
          sha: fixture.workflowSha,
        });
        expect(ghCalls.some((args) => ghApiEndpoint(args).endsWith("/actions/runs/123"))).toBe(
          true,
        );
        expect(ghCalls.some((args) => args[0] === "graphql")).toBe(false);
        expect(ghCalls.some((args) => args[0] === "run" && args[1] === "watch")).toBe(false);
        for (const read of ghCalls.filter(
          (args) => args[0] === "api" && ghApiMethod(args) === "GET",
        )) {
          expect(read).toContain("Cache-Control: max-age=0");
        }
        expect(readFileSync(fixture.pathGhCallsPath, "utf8")).toBe("");
        expect(gitCalls.filter((args) => args[0] === "push")).toEqual([]);
        expect(result.stdout).toContain(`Validation SHA: ${fixture.targetSha}`);
        expect(result.stdout).toContain(`Tooling SHA: ${fixture.workflowSha}`);
        expect(result.stdout).toContain(
          `Frozen validation tuple: candidate=${fixture.targetSha} tooling=${fixture.workflowSha} rerun_group=all`,
        );
        expect(result.stdout).toContain(
          "Parent run: https://github.com/openclaw/openclaw/actions/runs/123",
        );
        expect(result.stdout.indexOf("Parent run:")).toBeLessThan(
          result.stdout.indexOf("Parent run status:"),
        );
        expect(
          ghCalls.filter((args) => args[0] === "api" && ghApiMethod(args) === "DELETE"),
        ).toEqual([
          [
            "api",
            "--method",
            "DELETE",
            `repos/openclaw/openclaw/git/refs/heads/${workflowBranch}`,
            "--hostname",
            "github.com",
          ],
          [
            "api",
            "--method",
            "DELETE",
            `repos/openclaw/openclaw/git/refs/heads/${targetBranch}`,
            "--hostname",
            "github.com",
          ],
        ]);
        expect(runGit(fixture.origin, ["for-each-ref", "--format=%(refname)", "refs/heads"])).toBe(
          [
            "refs/heads/main",
            `refs/heads/${fixture.releaseRef}`,
            ...(correction ? [`refs/heads/${releaseRef}`] : []),
          ].join("\n"),
        );
      } finally {
        fixture.cleanup();
      }
    },
  );

  it("dispatches the canonical extended-stable tuple without conflating its SHAs", () => {
    const contextRef = "extended-stable/2026.8.33";
    const fixture = createDispatchFixture({
      releaseRef: contextRef,
      targetSource: {
        "package.json": '{"version":"2026.8.33"}\n',
        "CHANGELOG.md":
          "## 2026.8.33\n\nRelease notes for the complete extended-stable candidate.\n",
      },
    });
    try {
      const result = fixture.run([
        "--sha",
        fixture.targetSha,
        "--target-ref",
        contextRef,
        "--workflow-sha",
        fixture.workflowSha,
        "-f",
        "release_profile=stable",
        "-f",
        "run_release_soak=true",
        "-f",
        "fail_fast=false",
        "-f",
        "rerun_group=all",
        "-f",
        "reuse_evidence=false",
        "-f",
        "dispatch_release_evidence=false",
      ]);
      expect(result.status, result.stderr).toBe(0);
      const calls = fixture.readCalls(fixture.ghCallsPath);
      const dispatch = calls.find(isWorkflowDispatch) ?? [];
      const transportRef = ghField(dispatch, "ref");
      expect(transportRef).toMatch(
        new RegExp(`^release-ci/${fixture.workflowSha.slice(0, 12)}-[0-9]+$`, "u"),
      );
      expect(transportRef).not.toBe(fixture.targetSha);
      expect(transportRef).not.toBe(fixture.workflowSha);
      const inputs = dispatchedInputs(dispatch);
      expect(inputs).toMatchObject({
        ref: fixture.targetSha,
        expected_sha: fixture.targetSha,
        target_context_ref: contextRef,
        release_profile: "stable",
        run_release_soak: "true",
        fail_fast: "false",
        rerun_group: "all",
        reuse_evidence: "false",
        dispatch_release_evidence: "false",
      });
      expect(inputs.ref).not.toBe(contextRef);
      expect(inputs.trusted_workflow_json).toBe(
        JSON.stringify({ fullRef: "refs/heads/main", ref: "main", sha: fixture.workflowSha }),
      );
    } finally {
      fixture.cleanup();
    }
  });

  it.each([
    { failure: "target" as const, created: 0 },
    { failure: "workflow" as const, created: 1 },
  ])("retains refs when $failure ref creation has an ambiguous failure", ({ failure, created }) => {
    const fixture = createDispatchFixture({ createRefFailure: failure });
    try {
      const result = fixture.run(["--workflow-sha", fixture.workflowSha]);
      expect(result.status).toBe(1);
      expect(result.stderr).toContain(`configured ${failure} ref creation failure`);
      const calls = fixture.readCalls(fixture.ghCallsPath);
      const createCalls = calls.filter((args) => args[0] === "api" && ghApiMethod(args) === "POST");
      const deleteCalls = calls.filter(
        (args) => args[0] === "api" && ghApiMethod(args) === "DELETE",
      );
      expect(createCalls).toHaveLength(created + 1);
      expect(deleteCalls).toHaveLength(0);
      expect(calls.some(isWorkflowDispatch)).toBe(false);
      expect(fixture.readCalls(fixture.gitCallsPath).filter((args) => args[0] === "push")).toEqual(
        [],
      );
      expect(
        runGit(fixture.origin, [
          "for-each-ref",
          "--format=%(refname)",
          "refs/heads/release-ci",
          "refs/heads/validation",
        ])
          .split("\n")
          .filter(Boolean),
      ).toHaveLength(created);
    } finally {
      fixture.cleanup();
    }
  });

  it("uploads a local-only candidate before creating its temporary ref", () => {
    const fixture = createDispatchFixture({
      includeTargetRef: false,
      targetAlreadyRemote: false,
    });
    try {
      const result = fixture.run(["--workflow-sha", fixture.workflowSha]);
      expect(result.status, result.stderr).toBe(0);
      const ghCalls = fixture.readCalls(fixture.ghCallsPath);
      const targetCreate = ghCalls.find(
        (args) =>
          args[0] === "api" &&
          ghApiMethod(args) === "POST" &&
          ghField(args, "ref").startsWith("refs/heads/validation/target-"),
      );
      expect(targetCreate).toBeDefined();
      const targetRef = ghField(targetCreate ?? [], "ref");
      const pushes = fixture.readCalls(fixture.gitCallsPath).filter((args) => args[0] === "push");
      expect(pushes).toEqual([["push", "origin", `${fixture.targetSha}:${targetRef}`]]);
      expect(runGit(fixture.origin, ["cat-file", "-e", `${fixture.targetSha}^{commit}`])).toBe("");
      expect(
        runGit(fixture.origin, [
          "for-each-ref",
          "--format=%(refname)",
          "refs/heads/release-ci",
          "refs/heads/validation",
        ]),
      ).toBe("");
    } finally {
      fixture.cleanup();
    }
  });

  it("retains both refs after workflow dispatch is attempted", () => {
    const fixture = createDispatchFixture({ dispatchFailure: true });
    try {
      const result = fixture.run(["--workflow-sha", fixture.workflowSha]);
      expect(result.status).toBe(1);
      expect(result.stderr).toContain("dispatch=unknown");
      expect(JSON.parse(readFileSync(fixture.requestPath(), "utf8"))).toMatchObject({
        phase: "attempted",
        error: "unclassified",
        run: null,
      });
      const calls = fixture.readCalls(fixture.ghCallsPath);
      expect(calls.filter((args) => args[0] === "api" && ghApiMethod(args) === "DELETE")).toEqual(
        [],
      );
      expect(
        runGit(fixture.origin, [
          "for-each-ref",
          "--format=%(refname)",
          "refs/heads/release-ci",
          "refs/heads/validation",
        ]).split("\n"),
      ).toHaveLength(2);
    } finally {
      fixture.cleanup();
    }
  });

  it("attempts both ref deletions and reports every cleanup failure", () => {
    const fixture = createDispatchFixture({ deleteRefFailures: ["workflow", "target"] });
    try {
      const result = fixture.run(["--workflow-sha", fixture.workflowSha]);
      expect(result.status).toBe(1);
      expect(result.stderr).toContain("Failed to delete temporary refs");
      expect(result.stderr).toContain("configured workflow ref deletion failure");
      expect(result.stderr).toContain("configured target ref deletion failure");
      const deleteCalls = fixture
        .readCalls(fixture.ghCallsPath)
        .filter((args) => args[0] === "api" && ghApiMethod(args) === "DELETE");
      expect(deleteCalls).toHaveLength(2);
      expect(ghApiEndpoint(deleteCalls[0] ?? [])).toContain("/git/refs/heads/release-ci/");
      expect(ghApiEndpoint(deleteCalls[1] ?? [])).toContain("/git/refs/heads/validation/target-");
    } finally {
      fixture.cleanup();
    }
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
    try {
      const result = fixture.run(["--workflow-sha", fixture.workflowSha]);
      expect(result.status, result.stderr).toBe(0);
      const calls = fixture.readCalls(fixture.ghCallsPath);
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
    } finally {
      fixture.cleanup();
    }
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
    try {
      const result = fixture.run(["--workflow-sha", fixture.workflowSha]);
      expect(result.status, result.stderr).toBe(0);
      const calls = fixture.readCalls(fixture.ghCallsPath);
      expect(
        calls.filter((args) => ghApiEndpoint(args).endsWith("/actions/runs/123")),
      ).toHaveLength(7);
      expect(calls.filter((args) => args[0] === "run" && args[1] === "download")).toHaveLength(2);
    } finally {
      fixture.cleanup();
    }
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
    try {
      const result = fixture.run(["--workflow-sha", fixture.workflowSha]);
      expect(result.status, result.stderr).toBe(1);
      expect(result.stderr).toContain("blocked_diagnostics_running");
      expect(fixture.readWaits()).toEqual([120_000]);
      const calls = fixture.readCalls(fixture.ghCallsPath);
      expect(calls.filter((args) => args[0] === "run" && args[1] === "download")).toHaveLength(1);
      expect(calls.some((args) => args.includes("cancel") || args.includes("watch"))).toBe(false);
      expect(
        runGit(fixture.origin, [
          "for-each-ref",
          "--format=%(refname)",
          "refs/heads/release-ci",
          "refs/heads/validation",
        ]).split("\n"),
      ).toHaveLength(2);
    } finally {
      fixture.cleanup();
    }
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
    try {
      const result = fixture.run(["--workflow-sha", fixture.workflowSha]);
      expect(result.status, result.stderr).toBe(1);
      expect(result.stderr).toContain(
        "does not match the exact retained workflow/ref/event/attempt identity",
      );
      expect(fixture.readWaits()).toEqual([120_000, 120_000]);
      const downloads = fixture
        .readCalls(fixture.ghCallsPath)
        .filter((args) => args[0] === "run" && args[1] === "download");
      expect(downloads.map((args) => args[args.indexOf("--name") + 1])).toEqual([
        "full-release-decision-123-1",
      ]);
      expect(JSON.parse(readFileSync(fixture.requestPath(), "utf8")).run).toEqual({
        id: 123,
        attempt: 1,
      });
    } finally {
      fixture.cleanup();
    }
  });

  it("keeps progress reads sparse while checking unpublished decision metadata", () => {
    const fixture = createDispatchFixture({
      parentRunStates: [
        ...Array.from({ length: 10 }, () => ({ conclusion: null, status: "in_progress" })),
        { conclusion: "success", status: "completed" },
      ],
    });
    try {
      const result = fixture.run(["--workflow-sha", fixture.workflowSha]);
      expect(result.status, result.stderr).toBe(0);
      const calls = fixture.readCalls(fixture.ghCallsPath);
      expect(calls.filter((args) => args[0] === "run" && args[1] === "download")).toHaveLength(1);
      expect(calls.filter((args) => ghApiEndpoint(args).endsWith("/jobs"))).toHaveLength(1);
      expect(calls.filter((args) => ghApiEndpoint(args).endsWith("/artifacts"))).toHaveLength(11);
      expect(fixture.readWaits()).toEqual(Array(10).fill(120_000));
    } finally {
      fixture.cleanup();
    }
  });

  it.each([
    { label: "wrong name", artifacts: [{ name: "full-release-decision-999-1", expired: false }] },
    { label: "expired", artifacts: [{ name: "full-release-decision-123-1", expired: true }] },
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
    try {
      const result = fixture.run(["--workflow-sha", fixture.workflowSha]);
      expect(result.status, result.stderr).toBe(1);
      expect(result.stderr).toContain("blocked_complete");
      expect(fixture.readWaits()).toEqual([120_000]);
      const downloads = fixture
        .readCalls(fixture.ghCallsPath)
        .filter((args) => args[0] === "run" && args[1] === "download");
      expect(downloads).toHaveLength(1);
    } finally {
      fixture.cleanup();
    }
  });

  it.each([
    {
      label: "permanent denial",
      metadataError: "HTTP 403: Bad credentials",
      artifacts: undefined,
      error: "Bad credentials",
    },
    {
      label: "malformed response",
      metadataError: undefined,
      artifacts: {},
      error: "invalid artifacts",
    },
  ])(
    "stops on $label instead of hiding metadata failures as pending",
    ({ metadataError, artifacts, error }) => {
      const fixture = createDispatchFixture({
        parentRunStates: [{ conclusion: null, status: "in_progress", metadataError, artifacts }],
      });
      try {
        const result = fixture.run(["--workflow-sha", fixture.workflowSha]);
        expect(result.status, result.stderr).toBe(1);
        expect(result.stderr).toContain(error);
        expect(fixture.readWaits()).toEqual([]);
        expect(
          fixture
            .readCalls(fixture.ghCallsPath)
            .some((args) => args[0] === "run" && args[1] === "download"),
        ).toBe(false);
      } finally {
        fixture.cleanup();
      }
    },
  );

  it("recovers a transient metadata failure without downloading an unpublished artifact", () => {
    const fixture = createDispatchFixture({
      parentRunStates: [
        { conclusion: null, status: "in_progress", metadataError: "HTTP 503: Server Error" },
        { conclusion: "success", status: "completed" },
      ],
    });
    try {
      const result = fixture.run(["--workflow-sha", fixture.workflowSha]);
      expect(result.status, result.stderr).toBe(0);
      expect(result.stderr).toContain("metadata unavailable this poll");
      expect(fixture.readWaits()).toEqual([120_000]);
      expect(
        fixture
          .readCalls(fixture.ghCallsPath)
          .filter((args) => args[0] === "run" && args[1] === "download"),
      ).toHaveLength(1);
    } finally {
      fixture.cleanup();
    }
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
    try {
      const result = fixture.run(["--workflow-sha", fixture.workflowSha]);
      expect(result.status, result.stderr).toBe(1);
      expect(result.stderr).toContain("binding is invalid");
      expect(fixture.readWaits()).toEqual([]);
      expect(
        runGit(fixture.origin, [
          "for-each-ref",
          "--format=%(refname)",
          "refs/heads/release-ci",
          "refs/heads/validation",
        ]).split("\n"),
      ).toHaveLength(2);
    } finally {
      fixture.cleanup();
    }
  });

  it("dispatches non-main tooling only when its exact protected tag is supplied", () => {
    const fixture = createDispatchFixture();
    try {
      const result = fixture.run([
        "--workflow-sha",
        fixture.workflowSha,
        "--trusted-workflow-ref",
        fixture.trustedWorkflowTag,
      ]);
      expect(result.status, result.stderr).toBe(0);
      expect(result.stdout).toContain(`Trusted workflow ref: ${fixture.trustedWorkflowTag}`);
      expect(fixture.readCalls(fixture.gitCallsPath)).toContainEqual([
        "ls-remote",
        "--tags",
        "origin",
        `refs/tags/${fixture.trustedWorkflowTag}`,
      ]);
      const dispatch = fixture.readCalls(fixture.ghCallsPath).find(isWorkflowDispatch);
      const trustedIdentity = dispatchedInputs(dispatch ?? []).trusted_workflow_json;
      expect(JSON.parse(trustedIdentity ?? "{}")).toEqual({
        ref: fixture.trustedWorkflowTag,
        fullRef: `refs/tags/${fixture.trustedWorkflowTag}`,
        sha: fixture.workflowSha,
      });
    } finally {
      fixture.cleanup();
    }
  });

  it("disables evidence reuse and omits the contract 2 input for contract 1 tooling", () => {
    const fixture = createDispatchFixture({ workflowSource: CONTRACT_ONE_WORKFLOW_SOURCE });
    try {
      const result = fixture.run([
        "--workflow-sha",
        fixture.workflowSha,
        "--trusted-workflow-ref",
        fixture.trustedWorkflowTag,
      ]);
      expect(result.status, result.stderr).toBe(0);
      const dispatch = fixture.readCalls(fixture.ghCallsPath).find(isWorkflowDispatch);
      const inputs = dispatchedInputs(dispatch ?? []);
      expect(inputs).not.toHaveProperty("trusted_workflow_json");
      expect(inputs.reuse_evidence).toBe("false");
    } finally {
      fixture.cleanup();
    }
  });

  it("rejects pinned old-schema tooling before either remote ref is pushed", () => {
    const fixture = createDispatchFixture({
      workflowSource:
        'name: Full Release Validation\nenv:\n  RELEASE_ISOLATION_TOOLING_CONTRACT: "2"\non:\n  workflow_dispatch:\n',
    });
    try {
      const result = fixture.run(["--workflow-sha", fixture.workflowSha]);
      expect(result.status).toBe(1);
      expect(result.stderr).toContain(`Tooling SHA ${fixture.workflowSha}`);
      expect(result.stderr).toContain("missing workflow_dispatch input expected_sha");
      expect(fixture.readCalls(fixture.gitCallsPath).filter((args) => args[0] === "push")).toEqual(
        [],
      );
      expect(readFileSync(fixture.ghCallsPath, "utf8")).toBe("");
    } finally {
      fixture.cleanup();
    }
  });

  it("rejects pinned pre-contract tooling before either remote ref is pushed", () => {
    const fixture = createDispatchFixture();
    try {
      const result = fixture.run(["--workflow-sha", fixture.oldWorkflowSha]);
      expect(result.status).toBe(1);
      expect(result.stderr).toContain(`Tooling SHA ${fixture.oldWorkflowSha}`);
      expect(result.stderr).toContain(
        "does not declare a supported RELEASE_ISOLATION_TOOLING_CONTRACT",
      );
      expect(fixture.readCalls(fixture.gitCallsPath).filter((args) => args[0] === "push")).toEqual(
        [],
      );
      expect(readFileSync(fixture.ghCallsPath, "utf8")).toBe("");
    } finally {
      fixture.cleanup();
    }
  });

  it("rejects an arbitrary older release-branch ancestor with the wrong package version", () => {
    const fixture = createDispatchFixture();
    try {
      const result = fixture.run([
        "--sha",
        fixture.oldWorkflowSha,
        "--workflow-sha",
        fixture.workflowSha,
      ]);
      expect(result.status).toBe(1);
      expect(result.stderr).toContain(
        "Target package version 2026.7.9 does not belong to release branch release/2026.8.1; expected 2026.8.1 or a beta prerelease of it",
      );
      expect(fixture.readCalls(fixture.gitCallsPath).filter((args) => args[0] === "push")).toEqual(
        [],
      );
      expect(readFileSync(fixture.ghCallsPath, "utf8")).toBe("");
    } finally {
      fixture.cleanup();
    }
  });

  it("keeps both temporary refs with --keep-branch", () => {
    const fixture = createDispatchFixture();
    try {
      const result = fixture.run(["--workflow-sha", fixture.workflowSha, "--keep-branch"]);
      expect(result.status, result.stderr).toBe(0);
      const gitCalls = fixture.readCalls(fixture.gitCallsPath);
      expect(gitCalls.filter((args) => args[0] === "push")).toEqual([]);
      expect(
        fixture
          .readCalls(fixture.ghCallsPath)
          .some((args) => args[0] === "api" && ghApiMethod(args) === "DELETE"),
      ).toBe(false);
      const remoteRefs = runGit(fixture.origin, [
        "for-each-ref",
        "--format=%(refname)",
        "refs/heads/release-ci",
        "refs/heads/validation",
      ]).split("\n");
      expect(remoteRefs).toHaveLength(2);
      expect(remoteRefs).toEqual(
        expect.arrayContaining([
          expect.stringMatching(/^refs\/heads\/release-ci\//u),
          expect.stringMatching(/^refs\/heads\/validation\/target-/u),
        ]),
      );
    } finally {
      fixture.cleanup();
    }
  });

  it("fails clearly before dispatch when the target SHA is absent after the named fetch", () => {
    const fixture = createDispatchFixture();
    try {
      const missingSha = "f".repeat(40);
      const result = spawnSync(
        process.execPath,
        [
          SCRIPT_PATH,
          "--sha",
          missingSha,
          "--target-ref",
          fixture.releaseRef,
          "--workflow-sha",
          fixture.workflowSha,
        ],
        {
          cwd: fixture.checkout,
          encoding: "utf8",
          env: {
            ...process.env,
            MOCK_GH_CALLS: fixture.ghCallsPath,
            MOCK_GIT_CALLS: fixture.gitCallsPath,
            MOCK_ORIGIN: fixture.origin,
            MOCK_PATH_GH_CALLS: fixture.pathGhCallsPath,
            MOCK_REAL_PATH: process.env.PATH,
            MOCK_WORKFLOW_SHA: fixture.workflowSha,
            GH_TOKEN: "fixture-token",
            OPENCLAW_GH_BIN: fixture.selectedGhPath,
            PATH: `${join(fixture.checkout, "..", "bin")}:${process.env.PATH}`,
          },
        },
      );
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
    } finally {
      fixture.cleanup();
    }
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
