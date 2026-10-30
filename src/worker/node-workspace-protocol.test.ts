import { expect, it } from "vitest";
import {
  NODE_WORKSPACE_DRAIN_COMMAND,
  NODE_WORKSPACE_VALIDATE_DEVICE_FOLDER_COMMAND,
  NODE_WORKSPACE_QUIESCENCE_COMMAND,
  parseNodeWorkerWorkspaceExecInput,
  parseNodeWorkerWorkspaceExecResult,
} from "./node-workspace-protocol.js";
import {
  parseWorkspaceInspectionResult,
  WORKSPACE_INSPECTION_COMMAND,
  WORKSPACE_INSPECTION_MAX_BYTES,
} from "./workspace-inspection-protocol.js";
import { inspectSessionWorkspace } from "./workspace-inspection.js";

const request = {
  gatewayNamespace: "gateway-1",
  environmentId: "environment-1",
  sessionId: "session-1",
  generation: 1,
  argv: ["openclaw-internal-workspace-seed"],
};
const key = "a".repeat(64);
const seed = { action: "apply", key };
const download = { direction: "download", token: "token", manifestRef: `sha256:${key}` };
const upload = {
  direction: "upload",
  token: "token",
  baseManifestRef: `sha256:${key}`,
  referenceManifestRef: `sha256:${"b".repeat(64)}`,
};
const deviceFolder = "/projects/example";
const validation = { deviceFolder, argv: [NODE_WORKSPACE_VALIDATE_DEVICE_FOLDER_COMMAND] };
const completedResult = {
  workspaceDir: "/workspace",
  stdout: "",
  stderr: "",
  code: 0,
  signal: null,
  killed: false,
  termination: "exit",
};
const parse = (fields: Record<string, unknown>) =>
  parseNodeWorkerWorkspaceExecInput(JSON.stringify({ ...request, ...fields }));
const nonce = "c".repeat(32);
const quiescence = { action: "acquire", nonce, timeoutMs: 720_000 };
const quiescent = { argv: [NODE_WORKSPACE_QUIESCENCE_COMMAND, "/workspace"], quiescence };
const storedSeed = { action: "store", key, maxAgeMs: 0 };
const foreground = { argv: ["node", "-e", "0"] };
const seededDownload = { ...download, seedKey: key };
const managedMutations = [{ resetWorkspace: false }, { seed }, { transfer: download }];
function commandCase(owner: string, command: string, extra: Record<string, unknown>[] = []) {
  return {
    owner,
    base: { argv: [command] },
    valid: [{}],
    invalid: [{ argv: [command, "extra"] }, ...managedMutations, ...extra],
    reason: `workspace ${owner} owns its operation`,
  };
}

it("preserves empty operands while requiring a nonempty executable and bounded argv", () => {
  const argv = ["node", "-e", "process.stdout.write(process.argv[1])", "", "all"];
  expect(parse({ argv }).argv).toEqual(argv);
  for (const invalid of [
    [],
    [""],
    ["", "operand"],
    ["node", null],
    ["node", "bad\0operand"],
    Array.from({ length: 129 }, () => "node"),
    ["node", "x".repeat(128 * 1024 + 1)],
    ["node", "x".repeat(128 * 1024), "x".repeat(128 * 1024)],
  ]) {
    expect(() => parse({ argv: invalid })).toThrow("INVALID_REQUEST");
  }
});

it("preserves admitted host results but rejects malformed or inherited fields", () => {
  for (const workspaceDir of ["/workspace", "C:\\workspace"]) {
    const result = {
      ...completedResult,
      workspaceDir,
      stdoutTruncatedBytes: undefined,
      stderrTruncatedBytes: Number.MAX_SAFE_INTEGER,
      noOutputTimedOut: false,
      outputLimitExceeded: undefined,
      outputErrorStream: "stderr",
      process: { processId: "worker:1", state: "exited" },
    };
    expect(parseNodeWorkerWorkspaceExecResult(result)).toBe(result);
  }
  for (const invalid of [
    ...[
      { workspaceDir: "relative" },
      { stdout: "🦞".repeat(16_384) + "x" },
      { stderr: "🦞".repeat(4_096) + "x" },
      { code: Number.MAX_SAFE_INTEGER + 1 },
      { signal: "" },
      { stdoutTruncatedBytes: -1 },
      { stderrTruncatedBytes: 0.5 },
      { noOutputTimedOut: null },
      { outputLimitExceeded: null },
      { outputErrorStream: "stdin" },
      { process: null },
      { process: { processId: "../worker", state: "running" } },
      { process: { processId: "worker:1", state: "pending" } },
      { extra: true },
      { process: Object.create({ processId: "worker:1", state: "exited" }) },
    ].map((fields) => Object.assign({}, completedResult, fields)),
    Object.create(completedResult),
    Object.assign(Object.create({ process: undefined }), completedResult),
    Object.assign([], completedResult),
    Object.assign(Buffer.from("bytes"), completedResult),
  ]) {
    expect(parseNodeWorkerWorkspaceExecResult(invalid)).toBeNull();
  }
});

it.each<{
  owner: string;
  valid: Record<string, unknown>[];
  invalid: Record<string, unknown>[];
  base?: Record<string, unknown>;
  reason?: string;
}>([
  commandCase("drain", NODE_WORKSPACE_DRAIN_COMMAND, [{ input: "payload" }]),
  commandCase("inspection", WORKSPACE_INSPECTION_COMMAND),
  {
    owner: "transfer",
    valid: [seededDownload, upload].map((transfer) => ({ transfer })),
    invalid: [
      { ...seededDownload, seedKey: "../outside" },
      { ...seededDownload, seedKey: "A".repeat(64) },
      { ...seededDownload, attachments: true },
      { ...upload, seedKey: key },
      ...[undefined, null, "", "../outside", `sha256:${"B".repeat(64)}`].map(
        (referenceManifestRef) => Object.assign({}, upload, { referenceManifestRef }),
      ),
    ].map((transfer) => ({ transfer })),
    reason: "workspace transfer is invalid",
  },
  {
    owner: "seed",
    valid: [seed, storedSeed, { ...storedSeed, maxAgeMs: Number.MAX_SAFE_INTEGER }].map(
      (operation) => ({
        seed: operation,
      }),
    ),
    invalid: [
      ...[
        { ...seed, key: "../outside" },
        { ...seed, key: "A".repeat(64) },
        { action: "remove", key },
        { ...seed, maxAgeMs: 0 },
        { ...storedSeed, extra: true },
        { action: "store", key },
        ...[-1, Number.MAX_SAFE_INTEGER + 1, 0.5].map((maxAgeMs) =>
          Object.assign({}, storedSeed, { maxAgeMs }),
        ),
      ].map((operation) => ({ seed: operation })),
      { seed, resetWorkspace: false },
      { seed: storedSeed, transfer: download },
    ],
    reason: "INVALID_REQUEST:",
  },
  {
    owner: "quiescence",
    base: quiescent,
    valid: [
      {},
      { quiescence: { action: "renew", nonce, timeoutMs: 720_000, validationMode: "final" } },
      { quiescence: { action: "release", nonce } },
    ],
    invalid: [
      { argv: ["node", "-e", "arbitrary script"] },
      { input: "payload" },
      ...managedMutations,
      { process: { action: "start", processId: "app" } },
      { quiescence: { ...quiescence, nonce: "../other-lease" } },
      { quiescence: { ...quiescence, timeoutMs: 720_001 } },
    ],
  },
  {
    owner: "foreground",
    base: foreground,
    valid: [{}, { nativeProcessOwner: true }],
    invalid: [
      { nativeProcessOwner: false },
      { nativeProcessOwner: true, process: { action: "start", processId: "app" } },
      { nativeProcessOwner: true, seed },
      { ...quiescent, nativeProcessOwner: true },
    ],
  },
  {
    owner: "device folder",
    valid: [validation],
    invalid: [
      { deviceFolder: "" },
      { deviceFolder, resetWorkspace: false },
      { deviceFolder, seed },
      { deviceFolder, preparationKey: key },
      { argv: validation.argv },
      { ...validation, input: "x" },
    ],
    reason: "INVALID_REQUEST",
  },
])(
  "admits $owner inputs only within their operation authority",
  ({ owner, valid, invalid, reason, base }) => {
    for (const fields of valid) {
      const input = { ...base, ...fields };
      expect(parse(input)).toEqual({ ...request, ...input });
    }
    for (const fields of invalid) {
      expect(() => parse({ ...base, ...fields })).toThrow(reason);
    }
    if (owner === "quiescence") {
      expect(() => parse({ argv: quiescent.argv })).toThrow("quiescence owns its operation");
    }
  },
);

it("allows larger bounded inspection payloads without widening ordinary command limits", () => {
  const input = "x".repeat(192 * 1024);
  const argv = [WORKSPACE_INSPECTION_COMMAND];
  expect(parse({ argv, input }).input).toBe(input);
  expect(() => parse({ input })).toThrow("bound");
  const result = { ...completedResult, stdout: input };
  expect(parseNodeWorkerWorkspaceExecResult(result, argv)?.stdout).toBe(input);
  expect(parseNodeWorkerWorkspaceExecResult(result)).toBeNull();
  expect(
    parseNodeWorkerWorkspaceExecResult(
      { ...result, stdout: "x".repeat(WORKSPACE_INSPECTION_MAX_BYTES + 1) },
      argv,
    ),
  ).toBeNull();
});

it("preserves the worker file-boundary denial through result decoding", async () => {
  const raw = await inspectSessionWorkspace(
    "/workspace",
    JSON.stringify({
      operation: "get",
      sessionKey: "agent:main:worker-files",
      path: "../outside.txt",
      files: [],
    }),
    () => {},
  );
  const result = parseWorkspaceInspectionResult("get", raw);
  expect(result).toEqual({
    root: "/workspace",
    file: { path: "../outside.txt", name: "outside.txt", kind: "read", missing: true },
    reason: "outside_session_boundary",
  });
  for (const invalid of [
    { ...result, reason: "unknown" },
    { ...result, unexpected: true },
  ]) {
    expect(() => parseWorkspaceInspectionResult("get", JSON.stringify(invalid))).toThrow(
      "invalid result",
    );
  }
});
