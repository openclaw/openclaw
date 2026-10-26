import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { loadSessionEntry } from "../../config/sessions/session-accessor.js";
import type { InternalSessionEntry } from "../../config/sessions/types.js";
import { NODE_WORKER_WORKSPACE_EXEC_COMMAND } from "../../infra/node-commands.js";
import { closeOpenClawStateDatabaseForTest } from "../../state/openclaw-state-db.js";
import { NODE_WORKSPACE_VALIDATE_DEVICE_FOLDER_COMMAND } from "../../worker/node-workspace-protocol.js";
import { captureGatewayDeviceRevocation } from "../device-revocation.js";
import type {
  NodeWorkerSupervisorNodeProof,
  NodeWorkerSupervisorTransport,
} from "../node-registry-private.js";
import { controlUiClient } from "../server.sessions.create.projects.test-support.js";
import {
  directSessionReq,
  setupGatewaySessionsHandlerTestHarness,
} from "../test/server-sessions.test-helpers.js";
import { result as successfulCommand } from "../worker-environments/bootstrap.test-support.js";
import { createNodeWorkerBundleTestNode } from "../worker-environments/node-worker-bundle.test-support.js";
import { disposeSessionReadContexts } from "./sessions-read-cache.test-support.js";

const mocks = vi.hoisted(() => ({ getTransport: vi.fn() }));
vi.mock(import("../node-registry-private.js"), async (importOriginal) => ({
  ...(await importOriginal()),
  getNodeWorkerSupervisorTransport: mocks.getTransport,
}));
const { createSessionStoreDir } = setupGatewaySessionsHandlerTestHarness();
const folder = { deviceId: "node-1", path: "~/repo" };
const canonicalFolder = { deviceId: "node-1", path: "/home/test/repo" };
const key = "agent:main:dashboard:device-folder";
let storePath: string;
const read = () => loadSessionEntry({ agentId: "main", sessionKey: key, storePath });
let node: NodeWorkerSupervisorNodeProof;
const invoke = vi.fn<NodeWorkerSupervisorTransport["invoke"]>();
const getCurrentNode = vi.fn<NodeWorkerSupervisorTransport["getCurrentNode"]>();
const isCurrent = vi.fn<NodeWorkerSupervisorTransport["isCurrent"]>();
const validationResponse = (workspaceDir = canonicalFolder.path) => ({
  ok: true as const,
  payload: { ...successfulCommand({ stdout: "validated\n" }), workspaceDir },
});
const create = (
  params: Record<string, unknown> = { deviceFolder: folder },
  options: Parameters<
    typeof directSessionReq<{ entry: InternalSessionEntry }>
  >[2] = controlUiClient,
) =>
  directSessionReq<{ entry: InternalSessionEntry }>("sessions.create", { key, ...params }, options);
beforeEach(async () => {
  ({ storePath } = await createSessionStoreDir());
  node = createNodeWorkerBundleTestNode({
    nodeId: folder.deviceId,
    workerHost: { deviceFolders: true },
    commands: ["system.run"],
  });
  mocks.getTransport.mockReturnValue({
    getCurrentNode: getCurrentNode.mockReset().mockResolvedValue(node),
    listCurrentNodes: vi.fn(async () => [node]),
    hasCurrentRunner: () => true,
    isCurrent: isCurrent.mockReset().mockReturnValue(true),
    invoke: invoke.mockReset().mockImplementation(async (request) => {
      expect(request.isDispatchAuthorized()).toBe(true);
      return validationResponse();
    }),
  } satisfies NodeWorkerSupervisorTransport);
});
afterEach(async () => {
  await disposeSessionReadContexts();
  closeOpenClawStateDatabaseForTest();
});

test("sessions.create validates the node folder before persisting and publishes the canonical binding", async () => {
  const result = await create();
  expect(result.ok, JSON.stringify(result.error)).toBe(true);
  expect(invoke).toHaveBeenCalledWith(
    expect.objectContaining({
      command: NODE_WORKER_WORKSPACE_EXEC_COMMAND,
      params: expect.objectContaining({
        deviceFolder: folder.path,
        argv: [NODE_WORKSPACE_VALIDATE_DEVICE_FOLDER_COMMAND],
      }),
    }),
  );
  expect(result.payload?.entry.deviceFolder).toEqual(canonicalFolder);
  const first = read()!;
  expect(first.deviceFolder).toEqual(canonicalFolder);
  expect([first.sessionRoot, first.spawnedCwd, first.execNode, first.worktree]).toEqual(
    Array(4).fill(undefined),
  );
  first.deviceFolder!.path = "/changed-copy";
  expect(read()?.deviceFolder).toEqual(canonicalFolder);
  const described = await directSessionReq(
    "sessions.describe",
    { key },
    { ...controlUiClient, context: {} },
  );
  expect(described.ok, JSON.stringify(described.error)).toBe(true);
  expect(JSON.stringify(described.payload)).toContain(canonicalFolder.path);
});

test("sessions.create reuses only the same canonical device folder", async () => {
  const created = await create();
  expect(created.ok, JSON.stringify(created.error)).toBe(true);
  const reused = await create({ deviceFolder: canonicalFolder });
  expect(reused.ok, JSON.stringify(reused.error)).toBe(true);
  expect(reused.payload?.entry.sessionId).toBe(created.payload?.entry.sessionId);
  const omitted = await create({});
  expect(omitted.ok).toBe(false);
  invoke.mockResolvedValue(validationResponse("/home/example/other"));
  const changed = await create({ deviceFolder: { ...folder, path: "/home/example/other" } });
  expect(changed.ok).toBe(false);
  expect(read()?.deviceFolder).toEqual(canonicalFolder);
});

test.each([
  { worktree: false },
  { execNode: "other" },
  { message: "List the files" },
  { task: "List the files" },
  {
    attachments: [
      { type: "file", mimeType: "text/plain", fileName: "note.txt", content: "bm90ZQ==" },
    ],
  },
])(
  "sessions.create rejects conflicting device folder selection %j before node I/O",
  async (conflict) => {
    const result = await create({ deviceFolder: folder, ...conflict });
    expect(result).toMatchObject({
      ok: false,
      error: { code: "INVALID_REQUEST", message: expect.stringContaining("deviceFolder") },
    });
    expect(invoke).not.toHaveBeenCalled();
    expect(read()).toBeUndefined();
  },
);

test.each([
  ["offline", () => getCurrentNode.mockResolvedValue(undefined)],
  [
    "unsupported",
    () => {
      node.workerHost.deviceFolders = undefined;
    },
  ],
  ["denied", () => invoke.mockResolvedValue({ ok: false, error: { message: "denied" } })],
  ["malformed", () => invoke.mockResolvedValue({ ok: true, payload: {} })],
  ["disconnected", () => isCurrent.mockReturnValue(false)],
] as const)("sessions.create leaves no row after %s folder validation", async (_failure, fail) => {
  fail();
  const result = await create();
  expect(result.ok).toBe(false);
  expect(read()).toBeUndefined();
});

test.each(["caller", "device"] as const)(
  "sessions.create persists nothing when the %s is revoked while the node validates",
  async (revoked) => {
    let callerCurrent = true;
    const validated = invoke.getMockImplementation()!;
    invoke.mockImplementation(async (request) => {
      const response = await validated(request);
      if (revoked === "caller") {
        callerCurrent = false;
      } else {
        isCurrent.mockReturnValue(false);
      }
      return response;
    });
    // The request owner may reject by response or by throwing its authority error.
    const result = await create(undefined, {
      ...controlUiClient,
      hasCurrentClientAuthority: captureGatewayDeviceRevocation(
        {},
        { deviceId: "operator-device", role: "operator" },
        () => callerCurrent,
      ).isCurrent,
    }).catch((error: unknown) => ({ ok: false, error: { message: String(error) } }));
    expect(invoke).toHaveBeenCalledOnce();
    expect(result.ok).toBe(false);
    expect(read()).toBeUndefined();
  },
);
