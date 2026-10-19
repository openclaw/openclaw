import { setImmediate as nextTurn } from "node:timers/promises";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import { applyRemoteModelCatalogUpdate } from "../agents/prepared-model-runtime.js";
import { currentUpdateCheckLifecycle } from "../infra/update-check-lifecycle.js";
import { createEmptyPluginRegistry } from "../plugins/registry-empty.js";
import { getPluginRuntimeGatewayRequestScope } from "../plugins/runtime/gateway-request-scope.js";
import { resetGatewayWorkAdmission } from "../process/gateway-work-admission.js";
import { closeOpenClawStateDatabaseForTest } from "../state/openclaw-state-db.js";
import { createTestGatewayScheduler } from "../test-utils/gateway-scheduler-clock.js";
import { createOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { createDeferredGatewayUpdateCheck } from "./server-startup-update-check.js";

const mocks = vi.hoisted(() => ({
  createGatewayUpdateCheck:
    vi.fn<typeof import("../infra/update-startup.js").createGatewayUpdateCheck>(),
  startUpdateRunWatcher: vi.fn<typeof import("./update-run-watcher.js").startUpdateRunWatcher>(),
}));

vi.mock("../infra/update-startup.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../infra/update-startup.js")>()),
  createGatewayUpdateCheck: mocks.createGatewayUpdateCheck,
}));

vi.mock("./update-run-watcher.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./update-run-watcher.js")>()),
  startUpdateRunWatcher: mocks.startUpdateRunWatcher,
}));

vi.mock("../agents/prepared-model-runtime.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../agents/prepared-model-runtime.js")>()),
  applyRemoteModelCatalogUpdate: vi.fn(),
}));

type UpdateCheckStartupParams = Parameters<typeof createDeferredGatewayUpdateCheck>[0];
type UpdateCheck = ReturnType<typeof import("../infra/update-startup.js").createGatewayUpdateCheck>;
type Initialization = Awaited<ReturnType<UpdateCheck["initialize"]>>;
const initialized: Initialization = {
  root: null,
  status: { root: null, installKind: "unknown", packageManager: "unknown" },
  installReceipt: null,
};

let state: Awaited<ReturnType<typeof createOpenClawTestState>>;
let defaultUpdateCheck: UpdateCheck;
let scheduler: ReturnType<typeof createTestGatewayScheduler>;
const owners = new Set<ReturnType<typeof createDeferredGatewayUpdateCheck>>();

beforeEach(async () => {
  resetGatewayWorkAdmission();
  scheduler = createTestGatewayScheduler();
  state = await createOpenClawTestState({ label: "gateway-update-check" });
  defaultUpdateCheck = {
    initialize: vi.fn(async () => initialized),
    start: vi.fn(),
    stop: vi.fn(async () => {}),
  };
  mocks.createGatewayUpdateCheck.mockReset().mockReturnValue(defaultUpdateCheck);
  mocks.startUpdateRunWatcher
    .mockReset()
    .mockImplementation(
      (await vi.importActual<typeof import("./update-run-watcher.js")>("./update-run-watcher.js"))
        .startUpdateRunWatcher,
    );
});

afterEach(async () => {
  try {
    await Promise.all([...owners].map((owner) => owner.stop()));
    await scheduler.stop();
  } finally {
    owners.clear();
    resetGatewayWorkAdmission();
    closeOpenClawStateDatabaseForTest();
    await state.cleanup();
    vi.restoreAllMocks();
  }
});

async function startUpdateCheck(overrides: Partial<UpdateCheckStartupParams> = {}, start = true) {
  const owner = createDeferredGatewayUpdateCheck({
    scheduler,
    createUpdateCheck: async (...args) =>
      (await import("../infra/update-startup.js")).createGatewayUpdateCheck(...args),
    getConfig: () => ({}),
    getPluginRegistry: () => undefined,
    log: { info: vi.fn(), warn: vi.fn() },
    isNixMode: false,
    broadcastToConnIds: vi.fn(),
    getClientConnIds: () => new Set(),
    ...overrides,
  });
  owners.add(owner);
  if (start) {
    owner.start();
  }
  return owner;
}

async function waitForGatewayTestState(assertion: () => void | Promise<void>) {
  await vi.waitFor(assertion, { interval: 1 });
}

it("owns RPC update work when autonomous checks never start", async () => {
  const owner = await startUpdateCheck({}, false);
  const lifecycle = currentUpdateCheckLifecycle();
  const entered = createDeferred();
  const cleanup = createDeferred();
  const cancelled = createDeferred();
  const work = lifecycle.run(async (signal) => {
    signal.addEventListener("abort", () => cancelled.resolve(), { once: true });
    entered.resolve();
    await cleanup.promise;
  });
  await entered.promise;

  expect(scheduler.nextWakeAtMs).toBeNull();
  const stopped = vi.fn();
  const stopping = owner.stop().then(stopped);
  try {
    await cancelled.promise;
    expect(stopped).not.toHaveBeenCalled();
    expect(mocks.createGatewayUpdateCheck).not.toHaveBeenCalled();
  } finally {
    cleanup.resolve();
    await Promise.all([work, stopping]);
  }
  expect(stopped).toHaveBeenCalledOnce();
  expect(scheduler.nextWakeAtMs).toBeNull();
});

it.each(["background", "early manual"])(
  "scopes %s update broadcasts to read-capable operator clients",
  async (source) => {
    const clients = (
      [
        ["pairing", "operator", "operator.pairing"],
        ["node", "node", "node.read"],
        ["operator-read", "operator", "operator.read"],
      ] as const
    ).map(([connId, role, scope]) => ({ connId, connect: { role, scopes: [scope] } }));
    const broadcastToConnIds = vi.fn();
    const getClientConnIds: UpdateCheckStartupParams["getClientConnIds"] = (filter) =>
      new Set(
        clients
          .filter((client) => !filter || filter(client as never))
          .map((client) => client.connId),
      );
    const createGatewayUpdateCheck = mocks.createGatewayUpdateCheck;

    const ready = createDeferred();
    const result = await startUpdateCheck({
      ...(source === "early manual" ? { waitForPostReadyWork: () => ready.promise } : {}),
      broadcastToConnIds,
      getClientConnIds,
    });
    if (source === "background") {
      await waitForGatewayTestState(() => expect(createGatewayUpdateCheck).toHaveBeenCalledOnce());
    } else {
      expect(createGatewayUpdateCheck).not.toHaveBeenCalled();
    }

    const updateCheckParams =
      source === "background"
        ? createGatewayUpdateCheck.mock.calls[0]![0]
        : currentUpdateCheckLifecycle();
    const publicUpdate = {
      currentVersion: "2026.8.7",
      latestVersion: "2026.8.8",
      channel: "dev" as const,
    };
    const gitTarget = {
      currentSha: "1111111111111111111111111111111111111111",
      upstreamRef: "origin/main",
      upstreamSha: "2222222222222222222222222222222222222222",
      commitsBehind: 1,
      commits: [{ sha: "2222222", subject: "Detailed commit subject" }],
    };
    const updateAvailable = { ...publicUpdate, ...gitTarget };
    const schedule = {
      channel: "dev" as const,
      autoEnabled: true,
      install: { kind: "git" as const },
      target: { kind: "git" as const, ...gitTarget },
    };

    updateCheckParams.onUpdateAvailableChange?.(updateAvailable);
    updateCheckParams.onUpdateScheduleChange?.(schedule);

    const broadcast = (payload: unknown, ids: string[]) => [
      "update.available",
      payload,
      new Set(ids),
      { dropIfSlow: true },
    ];
    const publicBroadcast = broadcast({ updateAvailable: publicUpdate }, ["pairing", "node"]);
    expect(broadcastToConnIds.mock.calls).toEqual([
      broadcast({ updateAvailable }, ["operator-read"]),
      publicBroadcast,
      broadcast({ updateAvailable, schedule }, ["operator-read"]),
      publicBroadcast,
    ]);
    await result.stop();
    ready.resolve();
    broadcastToConnIds.mockClear();
    updateCheckParams.onUpdateAvailableChange?.(updateAvailable);
    updateCheckParams.onUpdateScheduleChange?.(schedule);
    expect(broadcastToConnIds).not.toHaveBeenCalled();
  },
);

it.each(["factory", "initialization"])("fences and joins a pending %s on close", async (phase) => {
  const factory = createDeferred();
  const factoryEntered = vi.fn();
  const updateStartup = await vi.importActual<typeof import("../infra/update-startup.js")>(
    "../infra/update-startup.js",
  );
  if (phase === "factory") {
    // Gate the real lazy import; the exported factory remains synchronous.
    vi.doMock("../infra/update-startup.js", async () => {
      factoryEntered();
      await factory.promise;
      return { ...updateStartup, createGatewayUpdateCheck: mocks.createGatewayUpdateCheck };
    });
  }
  const initialization = createDeferred<Initialization>();
  const initializationEntered = createDeferred();
  const cleanup = createDeferred();
  const updateCheck = {
    initialize: vi.fn(() => {
      initializationEntered.resolve();
      return initialization.promise;
    }),
    start: vi.fn(),
    stop: vi.fn(() => cleanup.promise),
  };
  mocks.createGatewayUpdateCheck.mockReturnValue(updateCheck);
  const result = await startUpdateCheck();
  const stopped = vi.fn();
  let stopping: Promise<void> | undefined;
  try {
    if (phase === "initialization") {
      await initializationEntered.promise;
      expect(updateCheck.initialize).toHaveBeenCalledOnce();
    } else {
      await waitForGatewayTestState(() => expect(factoryEntered).toHaveBeenCalledOnce());
      expect(mocks.createGatewayUpdateCheck).not.toHaveBeenCalled();
    }
    stopping = result.stop().then(stopped);
    if (phase === "factory") {
      await Promise.resolve();
      expect(stopped).not.toHaveBeenCalled();
      expect(updateCheck.stop).not.toHaveBeenCalled();
      factory.resolve();
      await waitForGatewayTestState(() => expect(updateCheck.stop).toHaveBeenCalledOnce());
      expect(updateCheck.initialize).not.toHaveBeenCalled();
    } else {
      expect(updateCheck.stop).toHaveBeenCalledOnce();
      cleanup.resolve();
      await nextTurn();
    }
    expect(stopped).not.toHaveBeenCalled();
    expect(updateCheck.start).not.toHaveBeenCalled();
  } finally {
    factory.resolve();
    cleanup.resolve();
    initialization.resolve(await defaultUpdateCheck.initialize());
    try {
      await (stopping ?? result.stop());
    } finally {
      if (phase === "factory") {
        // Keep the captured mock namespace, not a fresh singleton graph.
        vi.doMock("../infra/update-startup.js", () => ({
          ...updateStartup,
          createGatewayUpdateCheck: mocks.createGatewayUpdateCheck,
        }));
      }
    }
  }
  await result.stop();
  expect(updateCheck.stop).toHaveBeenCalledOnce();
});

it("joins update notices before releasing the update-check shutdown owner", async () => {
  const notices = createDeferred();
  const stopWatcher = vi.fn(() => notices.promise);
  mocks.startUpdateRunWatcher.mockReturnValue({ stop: stopWatcher });
  const result = await startUpdateCheck();
  const stopped = vi.fn();
  const stopping = result.stop().then(stopped);
  try {
    expect(stopWatcher).toHaveBeenCalledOnce();
    await waitForGatewayTestState(() => expect(defaultUpdateCheck.stop).toHaveBeenCalledOnce());
    await nextTurn();
    expect(stopped).not.toHaveBeenCalled();
    notices.resolve();
    await stopping;
    expect(stopped).toHaveBeenCalledOnce();
  } finally {
    notices.resolve();
    await stopping;
  }
});

it("warns once when initialization records unavailable Git facts", async () => {
  const warned = createDeferred();
  const warn = vi.fn(() => warned.resolve());
  defaultUpdateCheck.initialize = vi.fn<UpdateCheck["initialize"]>(async () => ({
    ...initialized,
    status: {
      ...initialized.status,
      error: { status: "failed", message: "Git discovery timed out", timeoutMs: 120_000 },
    },
  }));
  const owner = await startUpdateCheck({ log: { info: vi.fn(), warn } });
  await warned.promise;
  await owner.stop();
  expect(warn).toHaveBeenCalledExactlyOnceWith(
    "gateway update status failed to initialize: Error: Git discovery timed out",
  );
});

it("adopts scheduled remote catalogs inside the live Gateway registry scope", async () => {
  // Rebuilds must borrow this registry's existing plugin instances.
  const gatewayRegistry = createEmptyPluginRegistry();
  let adoptedIn: unknown;
  vi.mocked(applyRemoteModelCatalogUpdate).mockImplementation(async () => {
    adoptedIn = getPluginRuntimeGatewayRequestScope()?.pluginRegistry;
    return "published";
  });
  let applyRemoteCatalogUpdate: ((signal: AbortSignal) => Promise<unknown>) | undefined;
  mocks.createGatewayUpdateCheck.mockImplementation((params) => {
    applyRemoteCatalogUpdate = params.applyRemoteCatalogUpdate;
    return defaultUpdateCheck;
  });
  await startUpdateCheck({ getPluginRegistry: () => gatewayRegistry });
  await waitForGatewayTestState(() => expect(applyRemoteCatalogUpdate).toBeDefined());

  await expect(applyRemoteCatalogUpdate!(new AbortController().signal)).resolves.toBe("published");
  expect(adoptedIn).toBe(gatewayRegistry);
});
