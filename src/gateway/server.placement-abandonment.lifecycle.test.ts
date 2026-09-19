import { expect, test, vi, type TestContext } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import { runQaGatewayTestFixture } from "../../test/helpers/qa-gateway-test-lifetime.js";

type CaseBody = (
  value: { persisted: boolean; failed: boolean },
  context: TestContext,
) => Promise<void>;

test("abandonment fixture joins canceled startup and teardown before admitting another case", (context) => {
  const startupEntered = createDeferred();
  const releaseStartup = createDeferred();
  const closeEntered = createDeferred();
  const releaseClose = createDeferred();
  const cleanupEntered = createDeferred();
  const releaseCleanup = createDeferred();
  const cancel = new AbortController();
  const cancellation = new Error("abandonment body canceled");
  const finishers: Array<Parameters<TestContext["onTestFinished"]>[0]> = [];
  let run: CaseBody | undefined;
  let timeout: number | undefined;
  let body: Promise<unknown> | undefined;
  let finishing: Promise<unknown> | undefined;
  let importing: Promise<unknown> | undefined;
  let closed = false;
  let bodyFinished = false;
  let hookFinished = false;
  const fixtureContext: TestContext = {
    ...context,
    expect: context.expect,
    signal: cancel.signal,
    onTestFinished: (hook) => {
      finishers.push(hook);
    },
  };
  const state = {
    workspaceDir: "/fixture/workspace",
    configPath: "/fixture/config.json",
    path: (name: string) => "/fixture/" + name,
    writeConfig: vi.fn(async () => {}),
    cleanup: vi.fn(async () => {
      cleanupEntered.resolve();
      await releaseCleanup.promise;
    }),
  };
  let acquisitions = 0;
  const createState = vi.fn(async () => {
    acquisitions += 1;
    if (acquisitions > 1) {
      throw new Error("unexpected fixture overlap");
    }
    return state;
  });
  const child = { stdout: { resume() {} }, stderr: { resume() {} } };
  const spawn = vi.fn(() => child);
  const stopChild = vi.fn(async () => {});
  const disconnect = vi.fn(async () => {});
  const close = vi.fn(async () => {
    closeEntered.resolve();
    await releaseClose.promise;
    closed = true;
  });
  const closeDatabase = vi.fn();
  const createTunnel = () => ({});
  const modules = [
    "vitest",
    "node:child_process",
    "../../scripts/lib/gateway-bench-child.js",
    "../../scripts/lib/gateway-bench-probes.js",
    "../../scripts/lib/managed-child-process.mts",
    "../test-utils/openclaw-test-state.js",
    "./test-helpers.e2e.js",
    "./test-openai-responses-model.js",
    "./worker-environments/node-worker-tunnel.js",
    "./worker-environments/node-worker-tunnel.test-support.js",
    "../agents/worktrees/registry.js",
    "../config/sessions/archive-compression.js",
    "../config/sessions/session-accessor.js",
    "../state/openclaw-state-db.js",
    "./session-utils.js",
    "./worker-environments/placement-dispatch-test-fixtures.js",
    "./worker-environments/placement-record.js",
    "./worker-environments/placement-store.js",
    "./worker-environments/placement-test-fixtures.js",
    "./worker-environments/store.js",
  ];
  return runQaGatewayTestFixture(
    context,
    async () => {
      vi.resetModules();
      const vitest = await vi.importActual<typeof import("vitest")>("vitest");
      const collect = () => (_name: string, options: { timeout: number }, callback: CaseBody) => {
        timeout = options.timeout;
        run = callback;
      };
      // Load the real registered fixture body, supporting its pre-fix each registration too.
      vi.doMock("vitest", () => ({ ...vitest, it: { each: collect, for: collect } }));
      vi.doMock("node:child_process", async () => ({
        ...(await vi.importActual<typeof import("node:child_process")>("node:child_process")),
        spawn,
      }));
      vi.doMock("../../scripts/lib/gateway-bench-child.js", () => ({ stopChild }));
      vi.doMock("../../scripts/lib/gateway-bench-probes.js", () => ({
        getFreePort: async () => 1,
      }));
      vi.doMock("../../scripts/lib/managed-child-process.mts", async () => ({
        ...(await vi.importActual<typeof import("../../scripts/lib/managed-child-process.mts")>(
          "../../scripts/lib/managed-child-process.mts",
        )),
        inspectManagedProcessGroup: () => "dead",
      }));
      vi.doMock("../test-utils/openclaw-test-state.js", () => ({
        createOpenClawTestState: createState,
      }));
      vi.doMock("./worker-environments/node-worker-tunnel.js", () => ({
        createNodeWorkerTunnelManager: createTunnel,
      }));
      vi.doMock("./worker-environments/node-worker-tunnel.test-support.js", () => ({
        transport: () => ({
          getCurrentNode: async () => undefined,
          listCurrentNodes: async () => [],
          invoke: async () => ({ ok: true }),
        }),
      }));
      vi.doMock("./test-openai-responses-model.js", () => ({
        buildMockOpenAiResponsesProvider: () => ({
          modelRef: "fixture/model",
          providerId: "fixture",
          config: {},
        }),
      }));
      vi.doMock("./test-helpers.e2e.js", () => ({
        disconnectGatewayClient: disconnect,
        startGatewayWithClient: async () => {
          const tunnel = await import("./worker-environments/node-worker-tunnel.js");
          tunnel.createNodeWorkerTunnelManager(
            {} as Parameters<typeof tunnel.createNodeWorkerTunnelManager>[0],
          );
          startupEntered.resolve();
          await releaseStartup.promise;
          return { client: {}, port: 2, server: { startupSettled: Promise.resolve(), close } };
        },
      }));
      vi.doMock("../state/openclaw-state-db.js", () => ({
        closeOpenClawStateDatabaseForTest: closeDatabase,
        openOpenClawStateDatabase: vi.fn(),
      }));
      // Cancellation must fence seeding/RPC work after late startup returns.
      for (const [id, names] of [
        ["../agents/worktrees/registry.js", ["insertRegistryWorktree"]],
        ["../config/sessions/archive-compression.js", ["readSessionArchiveContentSync"]],
        ["../config/sessions/session-accessor.js", ["upsertSessionEntryCore"]],
        ["./session-utils.js", ["loadGatewaySessionEntryReadOnly"]],
        ["./worker-environments/placement-store.js", ["createWorkerSessionPlacementStore"]],
        ["./worker-environments/placement-test-fixtures.js", ["seedAttachedPlacementEnvironment"]],
        ["./worker-environments/store.js", ["createWorkerEnvironmentStore"]],
      ] as const) {
        vi.doMock(id, () =>
          Object.fromEntries(
            names.map((name) => [
              name,
              () => {
                throw new Error("canceled fixture reached " + name);
              },
            ]),
          ),
        );
      }
      vi.doMock("./worker-environments/placement-dispatch-test-fixtures.js", () => ({
        REQUEST: { sessionId: "session-1", sessionKey: "agent:main:session-1", agentId: "main" },
        seedActivePlacement: vi.fn(),
      }));
      vi.doMock("./worker-environments/placement-record.js", () => ({
        FORCED_WORKER_ABANDONMENT_ERROR: "abandoned",
      }));
      vi.stubGlobal(
        "fetch",
        vi.fn(async () => {
          if (closed) {
            throw new Error("listener closed");
          }
          return { status: 200 };
        }),
      );
      importing = import("./server.placement-abandonment.test.js");
      await importing;
      expect(run).toBeTypeOf("function");
      expect(timeout).toBe(90_000);
      body = run!({ persisted: false, failed: false }, fixtureContext).then(
        () => {
          bodyFinished = true;
        },
        (error: unknown) => {
          bodyFinished = true;
          return error;
        },
      );
      await Promise.race([startupEntered.promise, body]);
      expect(spawn).toHaveBeenCalledTimes(1);
      cancel.abort(cancellation);
      expect(finishers).toHaveLength(1);
      finishing = Promise.resolve(finishers[0]!(fixtureContext)).then(
        () => {
          hookFinished = true;
        },
        (error: unknown) => {
          hookFinished = true;
          return error;
        },
      );
      await expect(run!({ persisted: true, failed: false }, fixtureContext)).rejects.toThrow(
        "Previous placement abandonment fixture",
      );
      expect(createState).toHaveBeenCalledTimes(1);
      expect(spawn).toHaveBeenCalledTimes(1);
      expect(close).not.toHaveBeenCalled();
      expect(hookFinished).toBe(false);

      releaseStartup.resolve();
      await Promise.race([closeEntered.promise, body]);
      expect(close).toHaveBeenCalledTimes(1);
      expect(bodyFinished).toBe(false);
      expect(hookFinished).toBe(false);
      expect(state.cleanup).not.toHaveBeenCalled();
      releaseClose.resolve();
      await Promise.race([cleanupEntered.promise, body]);
      expect(state.cleanup).toHaveBeenCalledTimes(1);
      // The original body promise includes teardown; moving teardown only into
      // the finish hook would allow this callback to satisfy the 90-second timer.
      expect(bodyFinished).toBe(false);
      expect(hookFinished).toBe(false);
      await expect(run!({ persisted: true, failed: true }, fixtureContext)).rejects.toThrow(
        "Previous placement abandonment fixture",
      );
      expect(createState).toHaveBeenCalledTimes(1);
      releaseCleanup.resolve();
      expect(await body).toBe(cancellation);
      expect(await finishing).toBeUndefined();
      expect(disconnect).toHaveBeenCalledTimes(1);
      expect(close).toHaveBeenCalledTimes(1);
      expect(stopChild).toHaveBeenCalledTimes(1);
      expect(closeDatabase).toHaveBeenCalledTimes(1);
      expect(state.cleanup).toHaveBeenCalledTimes(1);
      const tunnel = await import("./worker-environments/node-worker-tunnel.js");
      expect(tunnel.createNodeWorkerTunnelManager).toBe(createTunnel);
    },
    async () => {
      // Before-fix failures still release the controlled owners before resetting mocks.
      releaseStartup.resolve();
      releaseClose.resolve();
      releaseCleanup.resolve();
      await Promise.allSettled([importing, body, finishing]);
      vi.restoreAllMocks();
      vi.unstubAllGlobals();
      for (const id of modules) {
        vi.doUnmock(id);
      }
      vi.resetModules();
    },
  );
});
