import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  resetGatewayWorkAdmission,
  tryBeginGatewayIndependentRootWorkAdmission,
  tryBeginGatewayRootWorkAdmission,
} from "../process/gateway-work-admission.js";

const mocks = vi.hoisted(() => ({
  events: [] as string[],
  executeRequest: vi.fn(),
  ensureSkillsWatcher: vi.fn(),
  prepareWorkspaceSkillEntries: vi.fn<
    typeof import("../skills/loading/workspace-skill-loader.js").prepareWorkspaceSkillEntries
  >(async () => ({ entries: [] })),
  prewarmContextWindowCacheAfterReady: vi.fn(async () => {}),
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
});

afterEach(() => {
  vi.useRealTimers();
  resetGatewayWorkAdmission();
});

describe("scheduleGatewayHandlerPrewarm", () => {
  it("prepares first-use modules and primary skills without executing requests or rebuilding rows", async () => {
    vi.useFakeTimers();
    const cfg: OpenClawConfig = {
      agents: {
        entries: {
          main: { workspace: workspaces.main },
          research: { workspace: workspaces.research },
        },
      },
    };

    const sidecar = scheduleGatewayHandlerPrewarm({
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
        mocks.prepareWorkspaceSkillEntries.mock.invocationCallOrder[0],
      );
      expect(mocks.prewarmContextWindowCacheAfterReady).toHaveBeenCalledOnce();
      expect(mocks.loadCombinedSessionStoreForGatewayCore).not.toHaveBeenCalled();
      expect(mocks.listManagedPlugins).toHaveBeenCalledWith({ config: cfg });
    } finally {
      await sidecar.stop();
    }
  });

  it("waits for gateway readiness before warming handler data", async () => {
    vi.useFakeTimers();
    const { promise: gatewayReady, resolve: releaseGatewayReady } = createDeferred();
    const load = vi.fn(async () => {});

    const sidecar = scheduleGatewayHandlerPrewarm({
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
  const handle = scheduleGatewayHandlerPrewarm({
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
  } finally {
    await handle.stop();
  }
});
