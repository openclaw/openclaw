import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core/expect";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  resetGatewayWorkAdmission,
  tryBeginGatewayIndependentRootWorkAdmission,
  tryBeginGatewayRootWorkAdmission,
} from "../process/gateway-work-admission.js";
import {
  createGatewaySchedulerClock,
  createTestGatewayScheduler,
} from "../test-utils/gateway-scheduler-clock.js";

const mocks = vi.hoisted(() => ({
  events: [] as string[],
  executeRequest: vi.fn(),
  ensureSkillsWatcher: vi.fn(),
  prepareWorkspaceSkillEntries: vi.fn<
    typeof import("../skills/loading/workspace-skill-loader.js").prepareWorkspaceSkillEntries
  >(async () => ({ entries: [] })),
  prewarmContextWindowCacheAfterReady: vi.fn(async () => {}),
  getMemoryCapabilityRegistration: vi.fn<() => { pluginId: string } | undefined>(),
  prewarmMemorySearchWorker: vi.fn(async () => {
    mocks.events.push("memory-search");
  }),
  loadBundledPluginPublicArtifactModuleSync: vi.fn(() => ({
    prewarmMemorySearchWorker: mocks.prewarmMemorySearchWorker,
  })),
  loadCombinedSessionStoreForGatewayCore: vi.fn((_cfg: unknown, options: { agentId: string }) => {
    mocks.events.push(`sessions.load.${options.agentId}`);
    return {
      durableStorePath: `/state/${options.agentId}.sqlite`,
      storePath: `/state/${options.agentId}.sqlite`,
      store: {},
    };
  }),
  listManagedPlugins: vi.fn(async () => {
    mocks.events.push("plugins");
    return { plugins: [] };
  }),
}));

vi.mock("../config/sessions/combined-store-gateway.js", () => ({
  loadCombinedSessionStoreForGatewayCore: mocks.loadCombinedSessionStoreForGatewayCore,
}));

vi.mock("../plugins/management-service.js", () => ({
  listManagedPlugins: mocks.listManagedPlugins,
}));

vi.mock("./server/ws-connection/message-handler.js", () => {
  mocks.events.push("connection");
  return { attachGatewayWsMessageHandler: mocks.executeRequest };
});
vi.mock("./server-chat.js", () => {
  mocks.events.push("agent-events");
  return { createAgentEventHandler: mocks.executeRequest };
});
vi.mock("./server-session-key.js", () => ({ resolveSessionKeyForRun: mocks.executeRequest }));
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
vi.mock("../skills/loading/workspace-skill-loader.js", () => ({
  prepareWorkspaceSkillEntries: mocks.prepareWorkspaceSkillEntries,
}));
vi.mock("../agents/workspace-access.js", () => ({ getAgentWorkspaceAccess: () => undefined }));
vi.mock("../skills/runtime/refresh.js", () => ({ ensureSkillsWatcher: mocks.ensureSkillsWatcher }));
vi.mock("../agents/context.js", () => ({
  prewarmContextWindowCacheAfterReady: mocks.prewarmContextWindowCacheAfterReady,
}));

vi.mock("../plugins/memory-state.js", () => ({
  getMemoryCapabilityRegistration: mocks.getMemoryCapabilityRegistration,
}));

vi.mock("../plugins/public-surface-loader.js", () => ({
  loadBundledPluginPublicArtifactModuleSync: mocks.loadBundledPluginPublicArtifactModuleSync,
}));

const { scheduleGatewayHandlerPrewarm } = await import("./server-startup-handler-prewarm.js");
const workspaces = {
  main: path.resolve("prewarm-main"),
  research: path.resolve("prewarm-research"),
};

beforeEach(() => {
  mocks.events.length = 0;
  mocks.executeRequest.mockClear();
  mocks.ensureSkillsWatcher.mockClear();
  mocks.prepareWorkspaceSkillEntries.mockClear();
  mocks.prewarmContextWindowCacheAfterReady.mockClear();
  mocks.loadCombinedSessionStoreForGatewayCore.mockClear();
  mocks.listManagedPlugins.mockClear();
  mocks.getMemoryCapabilityRegistration.mockReset();
  mocks.prewarmMemorySearchWorker.mockClear();
  mocks.loadBundledPluginPublicArtifactModuleSync.mockClear();
});

afterEach(() => {
  vi.useRealTimers();
  resetGatewayWorkAdmission();
});

describe("scheduleGatewayHandlerPrewarm", () => {
  it("prepares first-use modules, primary skills, and Memory Core in sequence without executing requests", async () => {
    vi.useFakeTimers();
    mocks.getMemoryCapabilityRegistration.mockReturnValue({ pluginId: "memory-core" });
    const cfg: OpenClawConfig = {
      agents: {
        entries: {
          main: { workspace: workspaces.main },
          research: { workspace: workspaces.research },
        },
      },
    };

    const sidecar = scheduleGatewayHandlerPrewarm({
      scheduler: createTestGatewayScheduler("fake-timers"),
      getConfig: () => cfg,
      log: { warn: vi.fn() },
    });

    try {
      expect(mocks.events).toEqual([]);
      // Dynamic imports can enqueue the next idle timer after the current timer drain.
      do {
        await vi.runAllTimersAsync();
        await vi.dynamicImportSettled();
      } while (vi.getTimerCount() > 0);

      expect(mocks.events).toContain("connection");
      expect(mocks.events).toContain("agent-events");
      expect(mocks.events.filter((event) => event === "handlers")).toHaveLength(3);
      expect(mocks.executeRequest).not.toHaveBeenCalled();
      expect(mocks.prepareWorkspaceSkillEntries.mock.calls).toEqual([
        [workspaces.main, { config: cfg, agentId: "main" }],
        [workspaces.research, { config: cfg, agentId: "research" }],
      ]);
      expect(mocks.ensureSkillsWatcher.mock.calls).toEqual([
        [{ workspaceDir: workspaces.main, config: cfg, agentId: "main" }],
        [{ workspaceDir: workspaces.research, config: cfg, agentId: "research" }],
      ]);
      expect(mocks.ensureSkillsWatcher.mock.invocationCallOrder[0]).toBeLessThan(
        expectDefined(
          mocks.prepareWorkspaceSkillEntries.mock.invocationCallOrder[0],
          "skill preparation call",
        ),
      );
      expect(mocks.prewarmContextWindowCacheAfterReady).toHaveBeenCalledOnce();
      expect(mocks.loadCombinedSessionStoreForGatewayCore).not.toHaveBeenCalled();
      expect(mocks.loadBundledPluginPublicArtifactModuleSync).toHaveBeenCalledOnce();
      expect(mocks.prewarmMemorySearchWorker).toHaveBeenCalledOnce();
      const memoryCall = expectDefined(
        mocks.prewarmMemorySearchWorker.mock.invocationCallOrder[0],
        "memory retrieval preparation call",
      );
      expect(mocks.prewarmContextWindowCacheAfterReady.mock.invocationCallOrder[0]).toBeLessThan(
        memoryCall,
      );
      expect(memoryCall).toBeLessThan(
        expectDefined(
          mocks.listManagedPlugins.mock.invocationCallOrder[0],
          "plugin preparation call",
        ),
      );
      expect(mocks.listManagedPlugins).toHaveBeenCalledWith({ config: cfg });
    } finally {
      await sidecar.stop();
    }
  });

  it.each([undefined, "memory-lancedb"])(
    "skips retrieval preparation when Memory Core is inactive (%s)",
    async (pluginId) => {
      vi.useFakeTimers();
      mocks.getMemoryCapabilityRegistration.mockReturnValue(pluginId ? { pluginId } : undefined);
      const sidecar = scheduleGatewayHandlerPrewarm({
        scheduler: createTestGatewayScheduler("fake-timers"),
        getConfig: () => ({ agents: { entries: {} } }),
        log: { warn: vi.fn() },
      });
      try {
        do {
          await vi.runAllTimersAsync();
          await vi.dynamicImportSettled();
        } while (vi.getTimerCount() > 0);
        expect(mocks.loadBundledPluginPublicArtifactModuleSync).not.toHaveBeenCalled();
        expect(mocks.prewarmMemorySearchWorker).not.toHaveBeenCalled();
        expect(mocks.listManagedPlugins).toHaveBeenCalledOnce();
      } finally {
        await sidecar.stop();
      }
    },
  );

  it("does not wait again when earlier work passes a later item's startup deadline", async () => {
    const clock = createGatewaySchedulerClock(1_000);
    const dateNow = vi.spyOn(Date, "now").mockReturnValue(1_000);
    const firstArmed = createDeferred();
    const nextArmed = createDeferred<number>();
    let arms = 0;
    const scheduler = createTestGatewayScheduler({
      ...clock.clock,
      arm: (run, delayMs) => {
        const cancel = clock.clock.arm(run, delayMs);
        if (arms++ === 0) {
          firstArmed.resolve();
        } else {
          nextArmed.resolve(delayMs);
        }
        return cancel;
      },
    });
    const later = vi.fn(async () => {});
    const sidecar = scheduleGatewayHandlerPrewarm({
      scheduler,
      getConfig: () => ({}),
      log: { warn: vi.fn() },
      items: [
        { name: "earlier", load: async () => clock.advanceBy(6_000) },
        { name: "later", notBeforeMs: 5_000, load: later },
      ],
    });
    try {
      await firstArmed.promise;
      await clock.wake();
      await expect(nextArmed.promise).resolves.toBe(0);
      expect(later).not.toHaveBeenCalled();
      await clock.wake();
      expect(later).toHaveBeenCalledOnce();
    } finally {
      await sidecar.stop();
      await scheduler.stop();
      dateNow.mockRestore();
    }
  });

  it("waits for gateway readiness before warming handler data", async () => {
    vi.useFakeTimers();
    const { promise: gatewayReady, resolve: releaseGatewayReady } = createDeferred();
    const load = vi.fn(async () => {});

    const sidecar = scheduleGatewayHandlerPrewarm({
      scheduler: createTestGatewayScheduler("fake-timers"),
      getConfig: () => ({}),
      log: { warn: vi.fn() },
      items: [{ name: "sessions", load }],
      waitForPostReadyWork: () => gatewayReady,
    });

    await vi.advanceTimersToNextTimerAsync();
    expect(load).not.toHaveBeenCalled();

    releaseGatewayReady();
    await vi.runAllTimersAsync();
    expect(load).toHaveBeenCalledOnce();
    await sidecar.stop();
  });

  it("waits for admitted request work before warming handler data", async () => {
    vi.useFakeTimers();
    const admission = tryBeginGatewayRootWorkAdmission();
    if (!admission) {
      throw new Error("Expected request work admission");
    }
    const load = vi.fn(async () => {});
    const sidecar = scheduleGatewayHandlerPrewarm({
      scheduler: createTestGatewayScheduler("fake-timers"),
      getConfig: () => ({}),
      log: { warn: vi.fn() },
      items: [{ name: "sessions", load }],
    });

    await vi.advanceTimersByTimeAsync(0);
    expect(load).not.toHaveBeenCalled();

    admission.release();
    await vi.advanceTimersByTimeAsync(249);
    expect(load).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(load).toHaveBeenCalledOnce();
    await sidecar.stop();
  });

  it("stays stopped when readiness arrives after shutdown", async () => {
    vi.useFakeTimers();
    const { promise: gatewayReady, resolve: releaseGatewayReady } = createDeferred();
    const load = vi.fn(async () => {});

    const sidecar = scheduleGatewayHandlerPrewarm({
      scheduler: createTestGatewayScheduler("fake-timers"),
      getConfig: () => ({}),
      log: { warn: vi.fn() },
      items: [{ name: "sessions", load }],
      waitForPostReadyWork: () => gatewayReady,
    });

    await vi.advanceTimersToNextTimerAsync();
    await sidecar.stop();
    releaseGatewayReady();
    await vi.runAllTimersAsync();

    expect(load).not.toHaveBeenCalled();
  });

  it("logs failures and continues without changing later request behavior", async () => {
    vi.useFakeTimers();
    const warn = vi.fn();
    const laterPrewarm = vi.fn(async () => {});
    const requestLoad = vi
      .fn<() => Promise<string>>()
      .mockRejectedValueOnce(new Error("cold read failed"))
      .mockResolvedValue("request result");

    scheduleGatewayHandlerPrewarm({
      scheduler: createTestGatewayScheduler("fake-timers"),
      getConfig: () => ({}),
      log: { warn },
      items: [
        {
          name: "broken",
          load: requestLoad,
        },
        { name: "later", load: laterPrewarm },
      ],
    });

    await vi.runAllTimersAsync();

    expect(warn).toHaveBeenCalledWith(
      "post-ready gateway data prewarm failed for broken: Error: cold read failed",
    );
    expect(requestLoad).toHaveBeenCalledOnce();
    expect(laterPrewarm).toHaveBeenCalledOnce();
    await expect(requestLoad()).resolves.toBe("request result");
  });

  it("stops before scheduling another event-loop turn", async () => {
    vi.useFakeTimers();
    let releaseFirst!: () => void;
    const first = vi.fn(
      async () =>
        await new Promise<void>((resolve) => {
          releaseFirst = resolve;
        }),
    );
    const second = vi.fn(async () => {});
    const sidecar = scheduleGatewayHandlerPrewarm({
      scheduler: createTestGatewayScheduler("fake-timers"),
      getConfig: () => ({}),
      log: { warn: vi.fn() },
      items: [
        { name: "first", load: first },
        { name: "second", load: second },
      ],
    });

    await vi.advanceTimersToNextTimerAsync();
    expect(first).toHaveBeenCalledOnce();
    const stopping = sidecar.stop();
    releaseFirst();
    await stopping;
    await vi.runAllTimersAsync();

    expect(second).not.toHaveBeenCalled();
  });
});

it("keeps the context cache delayed and uses current config after foreground work", async () => {
  vi.useFakeTimers();
  const initial: OpenClawConfig = { agents: { entries: {} } };
  let current = initial;
  const handle = scheduleGatewayHandlerPrewarm({
    scheduler: createTestGatewayScheduler("fake-timers"),
    getConfig: () => current,
    log: { warn: vi.fn() },
  });
  await vi.advanceTimersByTimeAsync(4_999);
  expect(mocks.prewarmContextWindowCacheAfterReady).not.toHaveBeenCalled();
  const request = tryBeginGatewayRootWorkAdmission();
  if (!request) {
    throw new Error("Expected foreground admission");
  }
  try {
    await vi.advanceTimersByTimeAsync(1);
    expect(mocks.prewarmContextWindowCacheAfterReady).not.toHaveBeenCalled();
    current = { agents: { entries: {} }, skills: { load: { watch: false } } };
    request.release();
    await vi.advanceTimersByTimeAsync(250);
    expect(mocks.prewarmContextWindowCacheAfterReady).toHaveBeenCalledWith({
      config: current,
      isCancelled: expect.any(Function),
    });
  } finally {
    request.release();
    await handle.stop();
  }
});

it("skips optional discovery when foreground work arrives after idle admission", async () => {
  vi.useFakeTimers();
  mocks.getMemoryCapabilityRegistration.mockReturnValue({ pluginId: "memory-core" });
  const handle = scheduleGatewayHandlerPrewarm({
    scheduler: createTestGatewayScheduler("fake-timers"),
    getConfig: () => ({ agents: { entries: { main: { workspace: workspaces.main } } } }),
    log: { warn: vi.fn() },
    startupTrace: {
      measure: async (_name, load) => {
        const request = tryBeginGatewayIndependentRootWorkAdmission("test-request");
        if (!request) {
          throw new Error("Expected foreground admission");
        }
        try {
          return await load();
        } finally {
          request.release();
        }
      },
    },
  });
  try {
    do {
      await vi.runAllTimersAsync();
      await vi.dynamicImportSettled();
    } while (vi.getTimerCount() > 0);
    expect(mocks.prepareWorkspaceSkillEntries).not.toHaveBeenCalled();
    expect(mocks.ensureSkillsWatcher).not.toHaveBeenCalled();
    expect(mocks.prewarmMemorySearchWorker).not.toHaveBeenCalled();
  } finally {
    await handle.stop();
  }
});
