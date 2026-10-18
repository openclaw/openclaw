import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { loadSessionEntry } from "../../config/sessions/session-accessor.js";
import type { InternalSessionEntry } from "../../config/sessions/types.js";
import { NODE_WORKER_WORKSPACE_EXEC_COMMAND } from "../../infra/node-commands.js";
import { NODE_WORKER_SUPERVISOR_PROTOCOL_FEATURE } from "../../infra/node-runner-inventory.js";
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
import { disposeSessionReadContexts } from "./sessions-read-cache.test-support.js";

const mocks = vi.hoisted(() => ({ getTransport: vi.fn() }));
vi.mock(import("../node-registry-private.js"), async (importOriginal) => ({
  ...(await importOriginal()),
  getNodeWorkerSupervisorTransport: mocks.getTransport,
}));
const { createSessionStoreDir } = setupGatewaySessionsHandlerTestHarness();
const folder = { deviceId: "device-one", path: "~/Projects/example" };
const canonicalFolder = { deviceId: "device-one", path: "/home/example/Projects/example" };
let node: NodeWorkerSupervisorNodeProof;
let transport: NodeWorkerSupervisorTransport;
const invoke = vi.fn<NodeWorkerSupervisorTransport["invoke"]>();
const getCurrentNode = vi.fn<NodeWorkerSupervisorTransport["getCurrentNode"]>();
const isCurrent = vi.fn<NodeWorkerSupervisorTransport["isCurrent"]>();
beforeEach(() => {
  node = {
    nodeId: folder.deviceId,
    connId: "conn-one",
    pairingIdentity: "paired-one",
    pairingGeneration: "generation-one",
    clientId: "node-host",
    clientMode: "node",
    protocolFeature: NODE_WORKER_SUPERVISOR_PROTOCOL_FEATURE,
    workerHost: { enabled: true, capacity: { total: 2, available: 2 }, deviceFolders: true },
    commands: ["system.run"],
  };
  transport = {
    getCurrentNode: getCurrentNode.mockReset().mockResolvedValue(node),
    listCurrentNodes: vi.fn(async () => [node]),
    hasCurrentRunner: () => true,
    isCurrent: isCurrent.mockReset().mockReturnValue(true),
    invoke: invoke.mockReset().mockImplementation(async (request) => {
      expect(request.isDispatchAuthorized()).toBe(true);
      return {
        ok: true,
        payload: {
          workspaceDir: canonicalFolder.path,
          stdout: "validated\n",
          stderr: "",
          code: 0,
          signal: null,
          killed: false,
          termination: "exit",
        },
      };
    }),
  };
  mocks.getTransport.mockReturnValue(transport);
});
afterEach(async () => {
  await disposeSessionReadContexts();
  closeOpenClawStateDatabaseForTest();
});

test("sessions.create validates the node folder before persisting and publishes the canonical binding", async () => {
  const { storePath } = await createSessionStoreDir();
  const key = "agent:main:dashboard:device-folder";
  const result = await directSessionReq<{ entry: InternalSessionEntry }>(
    "sessions.create",
    {
      key,
      deviceFolder: folder,
    },
    controlUiClient,
  );
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
  const scope = { agentId: "main", sessionKey: key, storePath };
  const first = loadSessionEntry(scope)!;
  expect(first.deviceFolder).toEqual(canonicalFolder);
  expect(first.sessionRoot).toBeUndefined();
  expect(first.spawnedCwd).toBeUndefined();
  expect(first.execNode).toBeUndefined();
  expect(first.worktree).toBeUndefined();
  first.deviceFolder!.path = "/changed-copy";
  expect(loadSessionEntry(scope)?.deviceFolder).toEqual(canonicalFolder);
  const described = await directSessionReq<{
    entry?: InternalSessionEntry;
    session?: InternalSessionEntry;
  }>("sessions.describe", { key }, { ...controlUiClient, context: {} });
  expect(described.ok, JSON.stringify(described.error)).toBe(true);
  expect(JSON.stringify(described.payload)).toContain(canonicalFolder.path);
});

test("sessions.create reuses only the same canonical device folder", async () => {
  const { storePath } = await createSessionStoreDir();
  const key = "agent:main:dashboard:reuse-device-folder";
  const created = await directSessionReq<{ entry: InternalSessionEntry }>(
    "sessions.create",
    { key, deviceFolder: folder },
    controlUiClient,
  );
  expect(created.ok, JSON.stringify(created.error)).toBe(true);
  const reused = await directSessionReq<{ entry: InternalSessionEntry }>(
    "sessions.create",
    { key, deviceFolder: canonicalFolder },
    controlUiClient,
  );
  expect(reused.ok, JSON.stringify(reused.error)).toBe(true);
  expect(reused.payload?.entry.sessionId).toBe(created.payload?.entry.sessionId);
  const omitted = await directSessionReq("sessions.create", { key }, controlUiClient);
  expect(omitted.ok).toBe(false);
  invoke.mockResolvedValue({
    ok: true,
    payload: {
      workspaceDir: "/home/example/other",
      stdout: "validated\n",
      stderr: "",
      code: 0,
      signal: null,
      killed: false,
      termination: "exit",
    },
  });
  const changed = await directSessionReq(
    "sessions.create",
    { key, deviceFolder: { ...folder, path: "/home/example/other" } },
    controlUiClient,
  );
  expect(changed.ok).toBe(false);
  expect(loadSessionEntry({ agentId: "main", sessionKey: key, storePath })?.deviceFolder).toEqual(
    canonicalFolder,
  );
});

test.each([
  { worktree: true },
  { worktree: false },
  { worktreeSource: "empty" },
  { worktreeBaseRef: "main" },
  { worktreeName: "topic" },
  { cwd: "/local" },
  { projectId: "project-one" },
  { projectGitUrl: "https://example.invalid/repo.git" },
  { repository: { url: "https://example.invalid/repo.git" } },
  { execNode: "other" },
  { catalogId: "catalog" },
  { fork: true, parentSessionKey: "agent:main:main", worktree: true },
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
    const { storePath } = await createSessionStoreDir();
    const key = "agent:main:dashboard:invalid-device-folder";
    const result = await directSessionReq(
      "sessions.create",
      { key, deviceFolder: folder, ...conflict },
      controlUiClient,
    );
    expect(result).toMatchObject({
      ok: false,
      error: { code: "INVALID_REQUEST", message: expect.stringContaining("deviceFolder") },
    });
    expect(invoke).not.toHaveBeenCalled();
    expect(loadSessionEntry({ agentId: "main", sessionKey: key, storePath })).toBeUndefined();
  },
);

test.each(["offline", "unsupported", "denied", "malformed", "disconnected"])(
  "sessions.create leaves no row after %s folder validation",
  async (failure) => {
    const { storePath } = await createSessionStoreDir();
    if (failure === "offline") {
      getCurrentNode.mockResolvedValue(undefined);
    }
    if (failure === "unsupported") {
      node.workerHost.deviceFolders = undefined;
    }
    if (failure === "denied") {
      invoke.mockResolvedValue({ ok: false, error: { message: "folder not allowed" } });
    }
    if (failure === "malformed") {
      invoke.mockResolvedValue({ ok: true, payload: {} });
    }
    if (failure === "disconnected") {
      isCurrent.mockReturnValue(false);
    }
    const key = "agent:main:dashboard:unavailable-device-folder";
    const result = await directSessionReq(
      "sessions.create",
      { key, deviceFolder: folder },
      controlUiClient,
    );
    expect(result.ok).toBe(false);
    expect(loadSessionEntry({ agentId: "main", sessionKey: key, storePath })).toBeUndefined();
  },
);

test.each(["caller", "device"] as const)(
  "sessions.create persists nothing when the %s is revoked while the node validates",
  async (revoked) => {
    const { storePath } = await createSessionStoreDir();
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
    const key = `agent:main:dashboard:revoked-${revoked}`;
    // The request owner may reject by response or by throwing its authority error.
    const result = await directSessionReq(
      "sessions.create",
      { key, deviceFolder: folder },
      {
        ...controlUiClient,
        hasCurrentClientAuthority: captureGatewayDeviceRevocation(
          {},
          { deviceId: "operator-device", role: "operator" },
          () => callerCurrent,
        ).isCurrent,
      },
    ).catch((error: unknown) => ({ ok: false, error: { message: String(error) } }));
    expect(invoke).toHaveBeenCalledOnce();
    expect(result.ok).toBe(false);
    expect(loadSessionEntry({ agentId: "main", sessionKey: key, storePath })).toBeUndefined();
  },
);
