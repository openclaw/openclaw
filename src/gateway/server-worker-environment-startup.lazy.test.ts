import { afterEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { createEmptyPluginRegistry } from "../plugins/registry-empty.js";
import {
  closeOpenClawStateDatabaseAsync,
  closeOpenClawStateDatabaseForTest,
} from "../state/openclaw-state-db.js";
import { createDesktopSessionRegistry } from "./desktop/session-registry.js";
import type { WorkerConnectionIdentity } from "./worker-environments/connection-identity.js";
import type {
  createWorkerEnvironmentService,
  WorkerEnvironmentService,
} from "./worker-environments/service.js";

type WorkerSessionToolExecutor = ReturnType<
  typeof import("./worker-environments/worker-session-tool-executor.js").createWorkerSessionToolExecutor
>;

const mocks = vi.hoisted(() => {
  const execute: WorkerSessionToolExecutor = vi.fn(async () => ({
    resultJson: '{"ok":true}',
  }));
  return {
    createExecutor: vi.fn(() => execute),
    execute,
    executeSessionTool: undefined as WorkerSessionToolExecutor | undefined,
    service: {
      get: vi.fn<WorkerEnvironmentService["get"]>(),
      ready: vi.fn<WorkerEnvironmentService["ready"]>(async () => {}),
      stop: vi.fn<WorkerEnvironmentService["stop"]>(async () => {}),
    } satisfies Pick<WorkerEnvironmentService, "get" | "ready" | "stop">,
  };
});

vi.mock("./worker-environments/service.js", () => ({
  createWorkerEnvironmentService: vi.fn(
    (options: Parameters<typeof createWorkerEnvironmentService>[0]) => {
      mocks.executeSessionTool = options.executeSessionTool;
      return mocks.service;
    },
  ),
}));

vi.mock("./worker-environments/worker-session-tool-executor.js", () => ({
  createWorkerSessionToolExecutor: mocks.createExecutor,
}));

import {
  createGatewayWorkerEnvironmentRuntime,
  loadGatewayWorkerEnvironmentStartupState,
} from "./server-worker-environment-startup.js";
import { withGatewayWorkerEnvironmentStartupState } from "./server-worker-environment-startup.state.test-support.js";

const tempDirs = useAutoCleanupTempDirTracker((cleanup) =>
  afterEach(async () => {
    await closeOpenClawStateDatabaseAsync();
    closeOpenClawStateDatabaseForTest();
    mocks.executeSessionTool = undefined;
    vi.clearAllMocks();
    cleanup();
  }),
);

describe("gateway worker session-tool startup", () => {
  it("creates one executor on concurrent first use", async () => {
    const stateDir = tempDirs.make("openclaw-worker-session-tool-lazy-");
    await withGatewayWorkerEnvironmentStartupState(stateDir, async () => {
      const startup = await loadGatewayWorkerEnvironmentStartupState();
      const registry = createEmptyPluginRegistry();
      await createGatewayWorkerEnvironmentRuntime({
        getPluginRegistry: () => registry,
        getPortalRuntime: () => undefined,
        resolveGatewayContext: () => undefined,
        desktopSessionRegistry: createDesktopSessionRegistry({ lingerMs: 1 }),
        startup,
        log: { child: () => ({ warn: () => {} }) },
      });

      expect(mocks.service.ready).toHaveBeenCalledOnce();
      expect(mocks.createExecutor).not.toHaveBeenCalled();
      const executeSessionTool = mocks.executeSessionTool;
      if (!executeSessionTool) {
        throw new Error("worker session-tool callback was not composed");
      }
      const identity: WorkerConnectionIdentity = {
        environmentId: "environment",
        credentialHash: "credential",
        bundleHash: "bundle",
        sessionId: null,
        runId: null,
        turnClaim: null,
        ownerEpoch: 1,
        rpcSetVersion: 1,
        protocolFeatures: [],
        credentialExpiresAtMs: Date.now() + 60_000,
      };
      const request: Parameters<WorkerSessionToolExecutor>[0] = {
        identity,
        toolName: "sessions_send",
        request: { toolCallId: "first", sessionKey: "agent:main:target", message: "hello" },
      };

      await expect(
        Promise.all([executeSessionTool(request), executeSessionTool(request)]),
      ).resolves.toEqual([{ resultJson: '{"ok":true}' }, { resultJson: '{"ok":true}' }]);
      expect(mocks.createExecutor).toHaveBeenCalledOnce();
      expect(mocks.execute).toHaveBeenCalledTimes(2);
    });
  });
});
