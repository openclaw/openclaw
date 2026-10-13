import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { withSessionTranscriptDeltaReader } from "../../config/sessions/session-transcript-delta-read.js";
import { NodeWorkerWorkspaceRuntime } from "../../node-host/node-worker-workspace.js";
import { nodeWorkerGatewayNamespace } from "../worker-environments/node-worker-gateway-namespace.js";
import type { WorkerWorkspaceCommand } from "../worker-environments/tunnel-contract.js";
import { sessionsFilesHandlers } from "./sessions-files.js";
import {
  createSessionFilesHandlerInvoker,
  createWorkspaceFixture,
  expectError,
  expectOkPayload,
  hashContent,
  removeWorkspaceFixture,
} from "./sessions-files.test-support.js";

const mocks = vi.hoisted(() => ({ load: vi.fn(), workspace: vi.fn(), releasePlacement: vi.fn() }));
// mock-isolation: Supply current session facts without opening a state database for synthetic sessions.
vi.mock("../../config/sessions/session-entry-source-authority.js", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("../../config/sessions/session-entry-source-authority.js")
  >()),
  captureSessionEntryMetadataRead: () => ({ readCurrent: () => mocks.load().entry }),
}));
vi.mock("../session-utils.js", () => ({ loadGatewaySessionEntryReadOnly: mocks.load }));
vi.mock("../session-utils-store-worker.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../session-utils-store-worker.js")>()),
  loadGatewaySessionEntryReadOnlyInWorker: async (params: { key: string; agentId?: string }) =>
    mocks.load(params.key, { agentId: params.agentId }),
}));
vi.mock("../../agents/agent-scope.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../agents/agent-scope.js")>()),
  resolveAgentWorkspaceDir: mocks.workspace,
}));
// mock-isolation: Device-folder tests have no transcript; the worker owns the file inventory.
vi.mock("../../config/sessions/session-transcript-delta-read.js", () => ({
  withSessionTranscriptDeltaReader: ((_scope, consume) =>
    consume({
      visible: async () => ({ kind: "missing" }),
      raw: async () => {
        throw new Error("Device-folder browsing must not read a local transcript");
      },
    })) satisfies typeof withSessionTranscriptDeltaReader,
}));

const invoke = createSessionFilesHandlerInvoker(sessionsFilesHandlers);
const sessionKey = "agent:main:device-folder";
const sessionId = "device-folder-session";
const environmentId = "device-folder-environment";
const deviceId = "paired-device";
let gatewayRoot: string;
let deviceRoot: string;
let runtimeRoot: string;
let runtime: NodeWorkerWorkspaceRuntime;
let active: boolean;
let lifecycleRevision: string;
let onResult: (() => void) | undefined;
let run: ReturnType<typeof vi.fn<(command: WorkerWorkspaceCommand) => Promise<any>>>;

function context() {
  const placement = {
    state: active ? "active" : "reclaimed",
    sessionId,
    sessionKey,
    agentId: "main",
    generation: 1,
    executionMode: "worker-turn",
    environmentId,
    activeOwnerEpoch: 1,
    remoteWorkspaceDir: deviceRoot,
  };
  return {
    getRuntimeConfig: () => ({ agents: { entries: { main: {} } } }),
    workerSessionPlacementService: {
      getMany: () => new Map([[sessionId, placement]]),
      prepareSessionPlacement: async () => ({
        current: () => placement,
        release: mocks.releasePlacement,
      }),
    },
    workerEnvironmentService: {
      get: () => ({
        state: "attached",
        ownerEpoch: 1,
        nodeDeviceId: deviceId,
        attachedSessionIds: [sessionId],
      }),
      startTunnel: async () => ({ environmentId, ownerEpoch: 1, runWorkspaceCommand: run }),
    },
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  gatewayRoot = createWorkspaceFixture("device-folder-files-gateway-");
  deviceRoot = createWorkspaceFixture("device-folder-files-device-");
  runtimeRoot = createWorkspaceFixture("device-folder-files-runtime-");
  fs.writeFileSync(path.join(gatewayRoot, "same.txt"), "GATEWAY\n");
  fs.writeFileSync(path.join(deviceRoot, "same.txt"), "DEVICE\n");
  runtime = new NodeWorkerWorkspaceRuntime({
    root: runtimeRoot,
    env: { PATH: process.env.PATH, HOME: runtimeRoot },
  });
  active = true;
  lifecycleRevision = "original";
  onResult = undefined;
  mocks.workspace.mockReturnValue(gatewayRoot);
  mocks.load.mockImplementation(() => ({
    agentId: "main",
    canonicalKey: sessionKey,
    cfg: {},
    storePath: path.join(gatewayRoot, "sessions.sqlite"),
    storeKeys: [sessionKey],
    entry: {
      sessionId,
      lifecycleRevision,
      deviceFolder: { deviceId, path: deviceRoot },
      spawnedCwd: gatewayRoot,
      spawnedWorkspaceDir: gatewayRoot,
    },
  }));
  run = vi.fn(async (command: WorkerWorkspaceCommand) => {
    command.assertCurrent?.();
    const result = await runtime.exec({
      gatewayNamespace: nodeWorkerGatewayNamespace(deviceId),
      environmentId,
      sessionId,
      generation: 1,
      deviceFolder: deviceRoot,
      argv: command.argv,
      input: command.input,
    });
    onResult?.();
    return result;
  });
});

afterEach(() => {
  removeWorkspaceFixture(runtimeRoot);
  removeWorkspaceFixture(deviceRoot);
  removeWorkspaceFixture(gatewayRoot);
});

it("lists, reads, and writes only the bound device folder", async () => {
  const ctx = context();
  const list = expectOkPayload(await invoke("sessions.files.list", { sessionKey }, ctx));
  expect(list.browser.entries.map((entry: { path: string }) => entry.path)).toContain("same.txt");
  expect(list.root).toBeUndefined();

  const before = expectOkPayload(
    await invoke("sessions.files.get", { sessionKey, path: "same.txt" }, ctx),
  );
  expect(before.file.content).toBe("DEVICE\n");
  expectOkPayload(
    await invoke(
      "sessions.files.set",
      {
        sessionKey,
        path: "same.txt",
        content: "SAVED ON DEVICE\n",
        expectedHash: hashContent("DEVICE\n"),
      },
      ctx,
    ),
  );

  expect(fs.readFileSync(path.join(deviceRoot, "same.txt"), "utf8")).toBe("SAVED ON DEVICE\n");
  expect(fs.readFileSync(path.join(gatewayRoot, "same.txt"), "utf8")).toBe("GATEWAY\n");
  expect(run).toHaveBeenCalledTimes(3);
  expect(mocks.releasePlacement).toHaveBeenCalledTimes(3);
});

it("returns a typed error while the paired-device placement is inactive", async () => {
  active = false;
  const error = expectError(await invoke("sessions.files.list", { sessionKey }, context()));
  expect(error).toMatchObject({
    details: { type: "device_folder_files_unavailable" },
    message: expect.stringContaining("Start this session"),
  });
  expect(run).not.toHaveBeenCalled();
  expect(mocks.releasePlacement).toHaveBeenCalledOnce();
});

it("rejects a session identity change before publishing device bytes", async () => {
  onResult = () => {
    lifecycleRevision = "changed";
  };
  await expect(
    invoke("sessions.files.get", { sessionKey, path: "same.txt" }, context()),
  ).rejects.toThrow("session changed");
  expect(mocks.releasePlacement).toHaveBeenCalledOnce();
});
