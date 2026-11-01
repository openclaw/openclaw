import { expectDefined } from "@openclaw/normalization-core/expect";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  resetGatewayWorkAdmission,
  markGatewayRestartDraining,
  tryBeginGatewayIndependentRootWorkAdmission,
  tryBeginGatewayRootWorkAdmission,
} from "../process/gateway-work-admission.js";
import { createTestGatewayScheduler } from "../test-utils/gateway-scheduler-clock.js";

const mocks = vi.hoisted(() => ({
  events: [] as string[],
  executeRequest: vi.fn(),
  prewarmLocalWorkspaceTemplates: vi.fn<
    typeof import("./worker-environments/local-workspace-prewarm.js").prewarmLocalWorkspaceTemplates
  >(async () => {}),
  prewarmGatewaySessionHistory: vi.fn(async () => {}),
  prewarmContextWindowCacheAfterReady: vi.fn(async () => {}),
  getMemoryCapabilityRegistration: vi.fn<() => { pluginId: string } | undefined>(),
  prewarmMemorySearchWorker: vi.fn(async () => {
    mocks.events.push("memory-search");
  }),
  loadBundledPluginPublicArtifactModuleSync: vi.fn(() => ({
    prewarmMemorySearchWorker: mocks.prewarmMemorySearchWorker,
  })),
  listManagedPlugins: vi.fn(async () => {
    mocks.events.push("plugins");
    return { plugins: [] };
  }),
}));

// mock-isolation: Exercise scheduling and cancellation without allocating repository containers.
vi.mock("./worker-environments/local-workspace-prewarm.js", () => ({
  prewarmLocalWorkspaceTemplates: mocks.prewarmLocalWorkspaceTemplates,
}));

vi.mock("./server-history-prewarm.js", () => ({
  prewarmGatewaySessionHistory: mocks.prewarmGatewaySessionHistory,
}));

vi.mock("../plugins/management-service.js", () => ({
  listManagedPlugins: mocks.listManagedPlugins,
}));

vi.mock("./server-chat.js", () => {
  mocks.events.push("agent-events");
  return { createAgentEventHandler: mocks.executeRequest };
});
vi.mock("./server-session-key.js", () => ({ resolveSessionForRun: mocks.executeRequest }));
vi.mock("./server-methods/core-handlers.js", async () => {
  const { createLazyCoreHandlers } = await import("./server-methods/lazy-core-handlers.js");
  return {
    coreGatewayHandlers: createLazyCoreHandlers({
      methods: ["chat.history", "chat.send", "sessions.list"],
      loadHandlers: async () => {
        mocks.events.push("handlers");
        return {
          "chat.history": mocks.executeRequest,
          "chat.send": mocks.executeRequest,
          "sessions.list": mocks.executeRequest,
        };
      },
    }),
  };
});
vi.mock("../agents/context.js", () => ({
  prewarmContextWindowCacheAfterReady: mocks.prewarmContextWindowCacheAfterReady,
}));

vi.mock("../plugins/memory-state.js", () => ({
  getMemoryCapabilityRegistration: mocks.getMemoryCapabilityRegistration,
}));

vi.mock("../plugins/public-surface-loader.js", () => ({
  loadBundledPluginPublicArtifactModuleSync: mocks.loadBundledPluginPublicArtifactModuleSync,
}));

const { scheduleGatewayHandlerPrewarm, scheduleGatewayPrewarm } =
  await import("./server-startup-handler-prewarm.js");

type PrewarmOptions = Parameters<typeof scheduleGatewayHandlerPrewarm>[0];
const sidecars: Array<ReturnType<typeof scheduleGatewayHandlerPrewarm>> = [];
const admissions: Array<NonNullable<ReturnType<typeof tryBeginGatewayRootWorkAdmission>>> = [];
function foreground() {
  const admission = expectDefined(tryBeginGatewayRootWorkAdmission(), "foreground admission");
  admissions.push(admission);
  return admission;
}
function prewarmOptions(options: Partial<PrewarmOptions> = {}): PrewarmOptions {
  return {
    scheduler: createTestGatewayScheduler("fake-timers"),
    getConfig: () => ({}),
    log: { warn: vi.fn() },
    ...options,
  };
}
function schedule(options: Partial<PrewarmOptions> = {}) {
  const sidecar = scheduleGatewayHandlerPrewarm(prewarmOptions(options));
  sidecars.push(sidecar);
  return sidecar;
}

async function drainPrewarm() {
  // Dynamic imports can enqueue another idle timer after the current timer drain.
  do {
    await vi.runAllTimersAsync();
    await vi.dynamicImportSettled();
  } while (vi.getTimerCount() > 0);
}

beforeEach(() => {
  vi.useFakeTimers();
  mocks.events.length = 0;
  vi.clearAllMocks();
  mocks.getMemoryCapabilityRegistration.mockReset();
});

afterEach(async () => {
  for (const admission of admissions.splice(0)) {
    admission.release();
  }
  await Promise.all(sidecars.splice(0).map((sidecar) => Promise.resolve(sidecar.stop())));
  vi.useRealTimers();
  resetGatewayWorkAdmission();
});

it("prewarms modules and Memory Core in order without executing requests", async () => {
  mocks.prewarmGatewaySessionHistory.mockImplementationOnce(async () => {
    mocks.events.push("session-history-worker");
  });
  mocks.prewarmContextWindowCacheAfterReady.mockImplementationOnce(async () => {
    mocks.events.push("context-window");
  });
  mocks.getMemoryCapabilityRegistration.mockReturnValue({ pluginId: "memory-core" });
  const cfg: OpenClawConfig = { agents: { entries: { main: {} } } };

  schedule({ getConfig: () => cfg });
  expect(mocks.events).toEqual([]);
  await drainPrewarm();

  expect(mocks.events).toEqual([
    "session-history-worker",
    "handlers",
    "handlers",
    "handlers",
    "agent-events",
    "context-window",
    "memory-search",
    "plugins",
  ]);
  expect(mocks.executeRequest).not.toHaveBeenCalled();
  expect(mocks.prewarmGatewaySessionHistory).toHaveBeenCalledExactlyOnceWith(cfg, {
    isCancelled: expect.any(Function),
  });
  expect(mocks.loadBundledPluginPublicArtifactModuleSync).toHaveBeenCalledOnce();
  expect(mocks.prewarmMemorySearchWorker).toHaveBeenCalledExactlyOnceWith(cfg);
  expect(mocks.listManagedPlugins).toHaveBeenCalledWith({ config: cfg });
});

it("skips retrieval preparation when Memory Core is inactive", async () => {
  schedule({ getConfig: () => ({ agents: { entries: {} } }) });
  await drainPrewarm();
  expect(mocks.loadBundledPluginPublicArtifactModuleSync).not.toHaveBeenCalled();
  expect(mocks.prewarmMemorySearchWorker).not.toHaveBeenCalled();
  expect(mocks.listManagedPlugins).toHaveBeenCalledOnce();
});

it("does not wait for an elapsed prewarm deadline", async () => {
  const startedAt = Date.now();
  let contextStartedAt: number | undefined;
  mocks.prewarmGatewaySessionHistory.mockImplementationOnce(async () => {
    vi.setSystemTime(Date.now() + 6_000);
  });
  mocks.prewarmContextWindowCacheAfterReady.mockImplementationOnce(async () => {
    contextStartedAt = Date.now();
  });

  schedule();
  await drainPrewarm();

  expect(mocks.prewarmGatewaySessionHistory).toHaveBeenCalledOnce();
  expect(mocks.prewarmContextWindowCacheAfterReady).toHaveBeenCalledOnce();
  expect(contextStartedAt).toBe(startedAt + 6_000);
});

it.each([
  ["handlers", false],
  ["handlers", true],
  ["dependencies", false],
  ["dependencies", true],
] as const)(
  "waits for readiness and respects shutdown (%s, stopped: %s)",
  async (kind, stopped) => {
    const ready = createDeferred();
    const warn = vi.fn();
    const observed =
      kind === "handlers"
        ? mocks.prewarmGatewaySessionHistory
        : mocks.prewarmLocalWorkspaceTemplates;
    const options = { waitForPostReadyWork: () => ready.promise, log: { warn } };
    const sidecar =
      kind === "handlers" ? schedule(options) : scheduleDependencyPreparation(options);
    await vi.advanceTimersByTimeAsync(0);
    expect(observed).not.toHaveBeenCalled();
    if (stopped) {
      await sidecar.stop();
    }
    ready.resolve();
    await drainPrewarm();
    expect(observed).toHaveBeenCalledTimes(stopped ? 0 : 1);
    await sidecar.stop();
    expect(warn).not.toHaveBeenCalled();
  },
);

it("prewarms only history while foreground work is active", async () => {
  foreground();
  const prepared: string[] = [];
  schedule({
    startupTrace: {
      measure: async (name, load) => {
        prepared.push(name);
        return await load();
      },
    },
  });
  await vi.advanceTimersByTimeAsync(0);
  await vi.dynamicImportSettled();
  await vi.advanceTimersByTimeAsync(250);
  expect(mocks.prewarmGatewaySessionHistory).toHaveBeenCalledOnce();
  expect(prepared).toEqual(["post-ready.gateway-data.session-history-worker"]);
});

it("logs a failed prewarm and continues to later items", async () => {
  const warn = vi.fn();
  mocks.prewarmGatewaySessionHistory.mockRejectedValueOnce(new Error("cold read failed"));

  schedule({ log: { warn } });
  await drainPrewarm();

  expect(warn).toHaveBeenCalledWith(
    "post-ready gateway data prewarm failed for session-history-worker: Error: cold read failed",
  );
  expect(mocks.prewarmGatewaySessionHistory).toHaveBeenCalledOnce();
  expect(mocks.prewarmContextWindowCacheAfterReady).toHaveBeenCalledOnce();
});

it("stops before scheduling another event-loop turn", async () => {
  const firstDone = createDeferred();
  mocks.prewarmGatewaySessionHistory.mockImplementationOnce(() => firstDone.promise);
  const sidecar = schedule();

  await vi.advanceTimersToNextTimerAsync();
  await vi.dynamicImportSettled();
  expect(mocks.prewarmGatewaySessionHistory).toHaveBeenCalledOnce();
  const stopping = sidecar.stop();
  firstDone.resolve();
  await stopping;
  await drainPrewarm();

  expect(mocks.events).not.toContain("handlers");
});
it("delays context prewarm and uses current config after foreground work", async () => {
  mocks.getMemoryCapabilityRegistration.mockReturnValue({ pluginId: "memory-core" });
  let current: OpenClawConfig = { agents: { entries: {} } };
  schedule({ getConfig: () => current });
  await vi.advanceTimersByTimeAsync(4_999);
  expect(mocks.prewarmContextWindowCacheAfterReady).not.toHaveBeenCalled();
  const request = foreground();
  await vi.advanceTimersByTimeAsync(1);
  expect(mocks.prewarmContextWindowCacheAfterReady).not.toHaveBeenCalled();
  current = {
    agents: { entries: { main: {} } },
    memory: { search: { enabled: false } },
    skills: { load: { watch: false } },
  };
  request.release();
  await vi.advanceTimersByTimeAsync(249);
  expect(mocks.prewarmContextWindowCacheAfterReady).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(1);
  expect(mocks.prewarmContextWindowCacheAfterReady).toHaveBeenCalledExactlyOnceWith({
    config: current,
    isCancelled: expect.any(Function),
  });
  await drainPrewarm();
  expect(mocks.prewarmMemorySearchWorker).toHaveBeenCalledExactlyOnceWith(current);
});

it("skips optional discovery if foreground work arrives after admission", async () => {
  mocks.getMemoryCapabilityRegistration.mockReturnValue({ pluginId: "memory-core" });
  schedule({
    startupTrace: {
      measure: async (_name, load) => {
        const request = expectDefined(
          tryBeginGatewayIndependentRootWorkAdmission("test-request"),
          "foreground admission",
        );
        try {
          return await load();
        } finally {
          request.release();
        }
      },
    },
  });
  await drainPrewarm();
  expect(mocks.prewarmMemorySearchWorker).not.toHaveBeenCalled();
  expect(mocks.prewarmGatewaySessionHistory).toHaveBeenCalledOnce();
});

function scheduleDependencyPreparation(options: Partial<PrewarmOptions> = {}) {
  const handles = scheduleGatewayPrewarm(prewarmOptions(options));
  const sidecar = {
    stop: async () => {
      await Promise.all(handles.map((handle) => Promise.resolve(handle.stop())));
    },
  };
  sidecars.push(sidecar);
  return sidecar;
}

it.each(["close", "restart"] as const)(
  "cancels dependency preparation on %s and joins installer cleanup",
  async (kind) => {
    const started = createDeferred<AbortSignal>();
    const cleanup = createDeferred();
    mocks.prewarmLocalWorkspaceTemplates.mockImplementationOnce(async ({ signal }) => {
      started.resolve(signal);
      await cleanup.promise;
    });
    const request = expectDefined(tryBeginGatewayRootWorkAdmission(), "foreground request");
    const handle = scheduleDependencyPreparation();
    let stopping: Promise<void> | undefined;
    try {
      await vi.advanceTimersByTimeAsync(0);
      const signal = await started.promise;
      if (kind === "restart") {
        markGatewayRestartDraining();
      }
      let closed = false;
      stopping = Promise.resolve(handle.stop()).then(() => {
        closed = true;
      });
      expect(signal.aborted).toBe(true);
      await Promise.resolve();
      expect(closed).toBe(false);
      cleanup.resolve();
      await stopping;
      expect(closed).toBe(true);
    } finally {
      request.release();
      cleanup.resolve();
      await handle.stop();
      await stopping;
    }
  },
);
