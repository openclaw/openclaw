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
function rejects(fields: Record<string, unknown>[], reason?: string, base = {}) {
  for (const field of fields) {
    expect(() => parse({ ...base, ...field })).toThrow(reason);
  }
}

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

it.each([
  {
    command: NODE_WORKSPACE_DRAIN_COMMAND,
    owner: "drain",
    mutations: [{ input: "payload" }, { resetWorkspace: true }, { seed }, { transfer: download }],
  },
  {
    command: WORKSPACE_INSPECTION_COMMAND,
    owner: "inspection",
    mutations: [{ resetWorkspace: false }, { seed }, { transfer: upload }],
  },
])(
  "admits $owner only without conflicting operation authority",
  ({ command, owner, mutations }) => {
    const operation = { argv: [command] };
    expect(parse(operation)).toEqual({ ...request, ...operation });
    rejects(
      [{ argv: [command, "extra"] }, ...mutations],
      `workspace ${owner} owns its operation`,
      operation,
    );
  },
);

it("admits prepared seeds only for downloads and requires an independent upload reference", () => {
  const seededDownload = { ...download, seedKey: key };
  for (const transfer of [seededDownload, upload]) {
    expect(parse({ transfer }).transfer).toEqual(transfer);
  }
  for (const transfer of [
    { ...seededDownload, seedKey: "../outside" },
    { ...seededDownload, seedKey: "A".repeat(64) },
    { ...seededDownload, attachments: true },
    { ...upload, seedKey: key },
  ]) {
    expect(() => parse({ transfer })).toThrow("INVALID_REQUEST:");
  }
  rejects(
    [undefined, null, "", "../outside", `sha256:${"B".repeat(64)}`].map((referenceManifestRef) => ({
      transfer: { ...upload, referenceManifestRef },
    })),
    "workspace transfer is invalid",
  );
});

it("admits only closed seed operations with bounded age and exclusive mutation ownership", () => {
  for (const operation of [
    seed,
    { action: "store", key, maxAgeMs: 0 },
    { action: "store", key, maxAgeMs: Number.MAX_SAFE_INTEGER },
  ]) {
    expect(parse({ seed: operation })).toEqual({ ...request, seed: operation });
  }
  rejects(
    [
      ...[
        { action: "apply", key: "../outside" },
        { action: "apply", key: "A".repeat(64) },
        { action: "remove", key },
        { action: "apply", key, maxAgeMs: 0 },
        { action: "store", key, maxAgeMs: 0, extra: true },
        { action: "store", key },
        ...[-1, Number.MAX_SAFE_INTEGER + 1, 0.5].map((maxAgeMs) => ({
          action: "store",
          key,
          maxAgeMs,
        })),
      ].map((operation) => ({ seed: operation })),
      { seed, resetWorkspace: true },
      { seed, resetWorkspace: false },
      { seed: { action: "store", key, maxAgeMs: 0 }, transfer: download },
    ],
    "INVALID_REQUEST:",
  );
});

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

it("admits bounded quiescence lifecycle operations without an arbitrary command", () => {
  const nonce = "c".repeat(32);
  const argv = [NODE_WORKSPACE_QUIESCENCE_COMMAND, "/workspace"];
  for (const quiescence of [
    { action: "acquire", nonce, timeoutMs: 720_000 },
    { action: "renew", nonce, timeoutMs: 720_000, validationMode: "final" },
    { action: "release", nonce },
  ]) {
    const input = { argv, quiescence };
    expect(parse(input)).toEqual({ ...request, ...input });
    rejects(
      [
        { argv: ["node", "-e", "arbitrary script"] },
        { input: "payload" },
        { resetWorkspace: false },
        { seed },
        { process: { action: "start", processId: "app" } },
        { quiescence: { ...quiescence, nonce: "../other-lease" } },
        { quiescence: { action: "acquire", nonce, timeoutMs: 720_001 } },
      ],
      undefined,
      input,
    );
  }
  expect(() => parse({ argv })).toThrow("quiescence owns its operation");
});

it("keeps foreground ownership opt-in and rejects combining operation owners", () => {
  const foreground = { argv: ["node", "-e", "0"] };
  expect(parse(foreground)).toEqual({ ...request, ...foreground });
  expect(parse({ ...foreground, nativeProcessOwner: true }).nativeProcessOwner).toBe(true);
  rejects(
    [
      { nativeProcessOwner: false },
      { nativeProcessOwner: true, process: { action: "start", processId: "app" } },
      { nativeProcessOwner: true, seed },
      {
        nativeProcessOwner: true,
        argv: [NODE_WORKSPACE_QUIESCENCE_COMMAND, "/workspace"],
        quiescence: { action: "release", nonce: "a".repeat(32) },
      },
    ],
    undefined,
    foreground,
  );
});

it("preserves device-folder requests and rejects managed mutations and malformed validation", () => {
  expect(parse(validation).deviceFolder).toBe(deviceFolder);
  rejects(
    [
      { deviceFolder: "" },
      { deviceFolder, resetWorkspace: false },
      { deviceFolder, seed },
      { deviceFolder, preparationKey: key },
      { argv: [NODE_WORKSPACE_VALIDATE_DEVICE_FOLDER_COMMAND] },
      { ...validation, input: "x" },
    ],
    "INVALID_REQUEST",
  );
});
