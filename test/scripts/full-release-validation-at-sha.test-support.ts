import { spawnSync } from "node:child_process";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach } from "vitest";
import { parse as parseYaml } from "yaml";
import {
  SCRIPT_PATH,
  testNodeExecPath,
  prepareDispatchRepository,
  runGit,
} from "./full-release-validation-at-sha.repository.test-support.js";
export {
  CURRENT_WORKFLOW_SOURCE,
  CONTRACT_ONE_WORKFLOW_SOURCE,
  LEGACY_WORKFLOW_SOURCE,
  runGit,
} from "./full-release-validation-at-sha.repository.test-support.js";

type DispatchWorkflow = { on?: { workflow_dispatch?: { inputs?: Record<string, unknown> } } };
const dispatchWorkflows = new Map<string, DispatchWorkflow>();
const fixtureCleanups = new Set<() => void>();
afterEach(() => {
  for (const cleanup of fixtureCleanups) {
    cleanup();
  }
});

export function createDispatchFixture(
  options: {
    candidateOwned?: boolean;
    admissionAcceptedFailure?: boolean;
    admissionMovedRef?: boolean;
    advanceMainBeforeAdmission?: number;
    admissionWrongRunSha?: boolean;
    admissionRevokedActor?: boolean;
    admissionFailedUpload?: boolean;
    qualificationMovedRef?: boolean;
    advanceMainAfterAdmission?: boolean;
    stopAfterAccepted?: "admission" | "qualification";
    bareShaFetchFailure?: boolean;
    createRefFailure?: boolean;
    deleteRefFailure?: boolean;
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
    witnessMissingReads?: number;
    witnessDuplicate?: boolean;
    ghRoute?: "path" | "explicit";
    tokenPresent?: boolean;
    artifactMetadata?: Record<string, unknown>;
    exactArtifactMetadata?: Record<string, unknown>;
    artifactReadError?: "metadata" | "archive";
    archiveEscapeFlag?: "required" | "unsupported";
    oversizedArtifactMetadata?: boolean;
    archiveFailure?: "oversized" | "truncated" | "corrupt" | "digest";
    inventoryError?: string;
    malformedInventory?: boolean;
    incompletePagination?: boolean;
    dispatchHttpStatus?: number;
    failIntentWrite?: boolean;
    stopBeforeDispatch?: boolean;
    reopenDuringDispatch?: boolean;
    payloadPreparationFailure?: "directory" | "write";
    payloadCleanupFailure?: boolean;
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
  const admissionCapturePath = join(root, "admission-payload.json");
  const admissionReceiptPath = join(root, "admission-receipt.json");
  const admissionFixturePath = resolve(
    "test/scripts/full-release-validation-at-sha.admission-fixture.mjs",
  );
  const acceptedStopPath = join(root, "accepted-stop");
  const npmCallsPath = join(root, "npm-calls.jsonl");
  const publishedVersionsPath = join(root, "published-versions.json");
  const fetchCallsPath = join(root, "fetch-calls.txt");
  const artifactTransportPath = join(root, "artifact-transport.jsonl");
  const payloadEventsPath = join(root, "payload-events.jsonl");
  const payloadCapturePath = join(root, "payload-capture.json");
  const preloadPath = join(root, "immediate-poll.mjs");
  const waitCallsPath = join(root, "wait-calls.txt");
  const releaseRef = options.releaseRef ?? "release/2026.8.1";
  mkdirSync(binDir);
  writeFileSync(npmCallsPath, "");
  writeFileSync(
    publishedVersionsPath,
    JSON.stringify(["2026.6.34", "2026.7.8", "2026.7.9", "2026.9.6"]),
  );
  const npmPath = join(binDir, "npm");
  writeFileSync(
    npmPath,
    `#!${testNodeExecPath}
const fs = require("node:fs");
const args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(npmCallsPath)}, JSON.stringify(args) + "\\n");
if (JSON.stringify(args) !== JSON.stringify(["view", "openclaw", "versions", "--json", "--silent", "--prefer-online"])) {
  throw new Error("No network: unexpected npm command " + args.join(" "));
}
if (fs.existsSync(${JSON.stringify(admissionCapturePath)}) || fs.existsSync(${JSON.stringify(acceptedRunPath)})) {
  throw new Error("Frozen admission/resume must not resolve registry baselines again");
}
process.stdout.write(fs.readFileSync(${JSON.stringify(publishedVersionsPath)}));
`,
  );
  chmodSync(npmPath, 0o755);
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
  if (${JSON.stringify(options.payloadPreparationFailure ?? "")} === "directory") {
    throw new Error("injected payload directory failure");
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
  const result = execute(file, args, options);
  const stop = ${JSON.stringify(options.stopAfterAccepted ?? "")};
  if (stop && args?.some((arg) => arg.endsWith((stop === "admission" ? "openclaw-release-prepare.yml" : "full-release-validation.yml") + "/dispatches")) &&
      !fs.existsSync(${JSON.stringify(acceptedStopPath)})) {
    fs.writeFileSync(${JSON.stringify(acceptedStopPath)}, "stopped after accepted POST");
    process.exit(78);
  }
  return result;
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

  const { oldWorkflowSha, workflowSha, trustedWorkflowTag, targetSha } = prepareDispatchRepository(
    root,
    options,
  );
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
const admissionEndpoint = endpoint.includes("/actions/workflows/openclaw-release-prepare.yml") ||
  endpoint.endsWith("/actions/workflows/18/runs") || endpoint.includes("/actions/runs/321/") ||
  endpoint.includes("/actions/artifacts/9002") || endpoint.includes("/contents/") ||
  endpoint.includes("/compare/") || endpoint.includes("/git/ref/") ||
  endpoint === "repos/openclaw/openclaw/collaborators/release-operator/permission";
if (${JSON.stringify(options.candidateOwned ?? false)} && args[0] === "api" && admissionEndpoint) {
  import(${JSON.stringify(admissionFixturePath)}).then(({ respond }) => respond(args,
    ${JSON.stringify({ origin, checkout, publisherSha: workflowSha, targetSha, admissionCapturePath, admissionReceiptPath, options })})).catch((error) => {
      console.error(error.stack); process.exitCode = 1;
    });
} else if (args[0] === "api" && method === "POST" && endpoint.endsWith("/git/refs")) {
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
} else if ((args[0] === "workflow" && args[1] === "run") || (method === "POST" && endpoint.endsWith("/dispatches"))) {
  const inputIndex = args.indexOf("--input");
  const payloadPath = inputIndex >= 0 ? args[inputIndex + 1] : undefined;
  const payloadText = payloadPath ? fs.readFileSync(payloadPath, "utf8") : undefined;
  const payload = payloadText === undefined ? undefined : JSON.parse(payloadText);
  const wireInputs = payload?.inputs ?? Object.fromEntries(args[0] === "workflow" ? fields : [...fields]
    .filter(([key]) => key.startsWith("inputs[")).map(([key, value]) => [key.slice(7, -1), value]));
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
    typedInputs: Object.fromEntries(Object.entries(wireInputs).map(([key, value]) => [
      key, JSON.parse(process.env.MOCK_WORKFLOW_SCHEMA)[key].type === "boolean" ? value === "true" : value,
    ])),
    ref: payload?.ref ?? (args[0] === "workflow" ? args[args.indexOf("--ref") + 1] : fields.get("ref")),
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
    if (failure === "truncated") bytes = bytes.subarray(0, bytes.length - 1);
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
      testNodeExecPath,
      [
        SCRIPT_PATH,
        // This fixture exercises retained main-derived requests. New candidate-owned
        // admission has its own P/Q boundary fixture below.
        ...(!recoveryOnly &&
        !options.candidateOwned &&
        !extraArgs.includes("--trusted-workflow-ref")
          ? ["--trusted-workflow-ref", "main", "--workflow-sha", workflowSha]
          : []),
        ...(!recoveryOnly && options.candidateOwned
          ? [
              "--admission-workflow-sha",
              workflowSha,
              "-f",
              "provider=openai",
              "-f",
              "release_profile=stable",
            ]
          : []),
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
          MOCK_WORKFLOW_SHA: options.candidateOwned ? targetSha : workflowSha,
          MOCK_VERIFIER_SHA: workflowSha,
          MOCK_ADVANCED_P_PATH: admissionCapturePath + ".advanced",
          GIT_AUTHOR_NAME: "Release Fixture",
          GIT_AUTHOR_EMAIL: "release-fixture@openclaw.invalid",
          GIT_COMMITTER_NAME: "Release Fixture",
          GIT_COMMITTER_EMAIL: "release-fixture@openclaw.invalid",
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
  const cleanup = () => {
    if (!fixtureCleanups.delete(cleanup)) {
      return;
    }
    for (const event of readPayloadEvents().filter((entry) => entry.stage === "created")) {
      rmSync(event.path, { force: true, recursive: true });
    }
    rmSync(root, { force: true, recursive: true });
  };
  fixtureCleanups.add(cleanup);
  return {
    checkout,
    acceptedRunPath,
    admissionCapturePath,
    admissionReceiptPath,
    npmCallsPath,
    publishedVersionsPath,
    artifactTransportPath,
    cleanup,
    calls,
    record: () => JSON.parse(readFileSync(requestPath(), "utf8")),
    dispatches: () => calls().filter(isWorkflowDispatch),
    gitCalls: () => readCalls(gitCallsPath),
    refs: () =>
      runGit(checkout, [
        "--git-dir",
        origin,
        "for-each-ref",
        "--format=%(refname)",
        "refs/heads/release-ci/",
      ])
        .split("\n")
        .filter(Boolean),
    ghCallsPath,
    fetchCallsPath,
    gitCallsPath,
    origin,
    oldWorkflowSha,
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
    releaseRef,
    run,
    selectedGhPath,
    targetSha,
    trustedWorkflowTag,
    workflowSha,
  };
}

export function ghApiEndpoint(args: string[]): string {
  return args.find((arg) => arg.startsWith("repos/openclaw/openclaw/")) ?? "";
}

export function ghApiMethod(args: string[]): string {
  const index = args.indexOf("--method");
  return index >= 0 ? (args[index + 1] ?? "") : "GET";
}

export function isWorkflowDispatch(args: string[]) {
  return (
    (args[0] === "workflow" && args[1] === "run") ||
    (ghApiMethod(args) === "POST" && ghApiEndpoint(args).endsWith("/dispatches"))
  );
}

export function ghField(args: string[], name: string): string {
  const prefix = `${name}=`;
  return (
    args
      .find((arg, index) => args[index - 1] === "-f" && arg.startsWith(prefix))
      ?.slice(prefix.length) ?? ""
  );
}
