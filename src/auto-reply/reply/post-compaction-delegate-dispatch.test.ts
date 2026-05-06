import fsSync from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { SessionEntry, SessionPostCompactionDelegate } from "../../config/sessions/types.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { withTempDir } from "../../test-helpers/temp-dir.js";
import type { ContinuationRuntimeConfig } from "../continuation/types.js";
import {
  buildPostCompactionLifecycleEvent,
  deliverQueuedPostCompactionDelegate,
  dispatchPostCompactionDelegates,
  normalizePostCompactionDelegate,
  persistPendingPostCompactionDelegates,
  takePendingPostCompactionDelegates,
  type PostCompactionDelegateDeliveryDeps,
  type PostCompactionDelegateDispatchDeps,
  type QueuedPostCompactionDelegateDelivery,
} from "./post-compaction-delegate-dispatch.js";
import type { FollowupRun } from "./queue/types.js";

const cfg: OpenClawConfig = {};

const defaultRuntimeConfig: ContinuationRuntimeConfig = {
  enabled: true,
  defaultDelayMs: 0,
  minDelayMs: 0,
  maxDelayMs: 1_000,
  maxChainLength: 4,
  costCapTokens: 500_000,
  maxDelegatesPerTurn: 5,
};

function delegate(
  task: string,
  overrides?: Partial<SessionPostCompactionDelegate>,
): SessionPostCompactionDelegate {
  return {
    task,
    createdAt: overrides?.createdAt ?? 1,
    ...(overrides?.firstArmedAt != null ? { firstArmedAt: overrides.firstArmedAt } : {}),
    ...(overrides?.silent != null ? { silent: overrides.silent } : {}),
    ...(overrides?.silentWake != null ? { silentWake: overrides.silentWake } : {}),
    ...(overrides?.traceparent ? { traceparent: overrides.traceparent } : {}),
  };
}

function createFollowupRun(overrides?: {
  workspaceDir?: string;
  originatingChannel?: FollowupRun["originatingChannel"];
  originatingAccountId?: string;
  originatingTo?: string;
  originatingThreadId?: string | number;
}): FollowupRun {
  return {
    prompt: "hello",
    enqueuedAt: 1,
    originatingChannel: overrides?.originatingChannel,
    originatingAccountId: overrides?.originatingAccountId,
    originatingTo: overrides?.originatingTo,
    originatingThreadId: overrides?.originatingThreadId,
    run: {
      agentId: "main",
      agentDir: "/tmp/agent",
      sessionId: "session",
      sessionKey: "main",
      sessionFile: "/tmp/session.jsonl",
      workspaceDir: overrides?.workspaceDir ?? "/tmp/workspace",
      config: cfg,
      provider: "anthropic",
      model: "claude",
      timeoutMs: 1_000,
      blockReplyBreak: "message_end",
    },
  };
}

function createDispatchDeps(options?: {
  staged?: SessionPostCompactionDelegate[];
  context?: string | null;
  contextError?: Error;
  rejectEnqueueAt?: number;
  runtimeConfig?: ContinuationRuntimeConfig;
  now?: number;
}) {
  const enqueueSystemEvent = vi.fn();
  const log = vi.fn();
  const readPostCompactionContext = vi.fn(async () => {
    if (options?.contextError) {
      throw options.contextError;
    }
    return options?.context ?? null;
  });
  const resolveAgentWorkspaceDir = vi.fn(() => "/fallback-workspace");
  const resolveContinuationRuntimeConfig = vi.fn(
    () => options?.runtimeConfig ?? defaultRuntimeConfig,
  );
  const enqueuePostCompactionDelegateDelivery = vi.fn(async ({ sequence }) => {
    if (options?.rejectEnqueueAt === sequence) {
      throw new Error("queue write failed");
    }
    return `queue-${sequence}`;
  });
  const drainPostCompactionDelegateDeliveries = vi.fn(async () => undefined);
  const deps: PostCompactionDelegateDispatchDeps = {
    consumeStagedPostCompactionDelegates: vi.fn(() => options?.staged ?? []),
    drainPostCompactionDelegateDeliveries,
    enqueuePostCompactionDelegateDelivery,
    enqueueSystemEvent,
    log,
    now: vi.fn(() => options?.now ?? 1),
    readPostCompactionContext,
    resolveAgentWorkspaceDir,
    resolveContinuationRuntimeConfig,
    resolveSessionAgentId: vi.fn(() => "main"),
  };
  return {
    deps,
    drainPostCompactionDelegateDeliveries,
    enqueuePostCompactionDelegateDelivery,
    enqueueSystemEvent,
    log,
    readPostCompactionContext,
    resolveAgentWorkspaceDir,
    resolveContinuationRuntimeConfig,
  };
}

function createQueuedEntry(
  overrides?: Partial<QueuedPostCompactionDelegateDelivery>,
): QueuedPostCompactionDelegateDelivery {
  return {
    id: "queue-1",
    kind: "postCompactionDelegate",
    sessionKey: "main",
    task: "queued delegate",
    createdAt: 1,
    enqueuedAt: 1,
    retryCount: 0,
    ...overrides,
  };
}

function createDeliveryDeps(params: {
  storePath: string;
  runtimeConfig?: Partial<ContinuationRuntimeConfig>;
  spawnStatus?: "accepted" | "forbidden" | "error";
  spawnError?: Error;
}) {
  const enqueueSystemEvent = vi.fn();
  const log = vi.fn();
  const spawnSubagentDirect = vi.fn(async () => {
    if (params.spawnError) {
      throw params.spawnError;
    }
    return { status: params.spawnStatus ?? "accepted" };
  });
  const deps: PostCompactionDelegateDeliveryDeps = {
    enqueueSystemEvent,
    getRuntimeConfig: vi.fn(() => cfg),
    loadSessionStore: vi.fn(
      (storePath) =>
        JSON.parse(fsSync.readFileSync(storePath, "utf-8")) as Record<string, SessionEntry>,
    ),
    log,
    now: vi.fn(() => 1_700_000_000_000),
    resolveContinuationRuntimeConfig: vi.fn(() => ({
      ...defaultRuntimeConfig,
      ...params.runtimeConfig,
    })),
    resolveSessionAgentId: vi.fn(() => "main"),
    resolveStorePath: vi.fn(() => params.storePath),
    spawnSubagentDirect,
  };
  return { deps, enqueueSystemEvent, log, spawnSubagentDirect };
}

async function flushMicrotasks(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

afterEach(() => {
  vi.useRealTimers();
});

describe("post-compaction delegate dispatch extraction", () => {
  it("normalizes legacy delegates as silent-wake", () => {
    expect(normalizePostCompactionDelegate(delegate("legacy"))).toEqual({
      task: "legacy",
      createdAt: 1,
      firstArmedAt: 1,
      silent: true,
      silentWake: true,
    });
  });

  it("preserves explicit silent=false without adding silentWake", () => {
    expect(normalizePostCompactionDelegate(delegate("visible", { silent: false }))).toEqual({
      task: "visible",
      createdAt: 1,
      firstArmedAt: 1,
      silent: false,
    });
  });

  it("preserves explicit silentWake=true without adding silent", () => {
    expect(normalizePostCompactionDelegate(delegate("wake", { silentWake: true }))).toEqual({
      task: "wake",
      createdAt: 1,
      firstArmedAt: 1,
      silentWake: true,
    });
  });

  it("preserves explicit firstArmedAt while leaving createdAt unchanged", () => {
    expect(
      normalizePostCompactionDelegate(
        delegate("requeued", { createdAt: 20_000, firstArmedAt: 10_000 }),
      ),
    ).toEqual({
      task: "requeued",
      createdAt: 20_000,
      firstArmedAt: 10_000,
      silent: true,
      silentWake: true,
    });
  });

  it("builds the same lifecycle event text as the runner block", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-04-26T22:00:00.000Z"));

    expect(
      buildPostCompactionLifecycleEvent({
        compactionCount: 3,
        queuedDelegates: 2,
        droppedDelegates: 1,
      }),
    ).toBe(
      "[system:post-compaction] Session compacted at 2026-04-26T22:00:00.000Z. Compaction count: 3. Queued 2 post-compaction delegate(s) for delivery into the fresh session. 1 delegate(s) were not released into the fresh session.",
    );
  });

  it("persists new pending delegates locally after existing delegates", async () => {
    const sessionEntry: SessionEntry = {
      sessionId: "session",
      updatedAt: 1,
      pendingPostCompactionDelegates: [delegate("existing")],
    };
    const sessionStore = { main: sessionEntry };

    const persisted = await persistPendingPostCompactionDelegates({
      sessionEntry,
      sessionStore,
      sessionKey: "main",
      delegates: [delegate("new", { silent: false })],
    });

    expect(persisted.map((item) => item.task)).toEqual(["existing", "new"]);
    expect(sessionEntry.pendingPostCompactionDelegates).toEqual(persisted);
    expect(sessionStore.main.pendingPostCompactionDelegates).toEqual(persisted);
  });

  it("takes and clears pending delegates from the session store path", async () => {
    await withTempDir({ prefix: "openclaw-post-compaction-dispatch-" }, async (tempDir) => {
      const storePath = path.join(tempDir, "sessions.json");
      await fs.writeFile(
        storePath,
        JSON.stringify(
          {
            main: {
              sessionId: "session",
              updatedAt: 1,
              pendingPostCompactionDelegates: [delegate("persisted")],
            },
          },
          null,
          2,
        ),
        "utf-8",
      );

      const taken = await takePendingPostCompactionDelegates({
        sessionKey: "main",
        storePath,
      });

      expect(taken).toEqual([normalizePostCompactionDelegate(delegate("persisted"))]);
      const stored = JSON.parse(await fs.readFile(storePath, "utf-8")) as Record<
        string,
        SessionEntry
      >;
      expect(stored.main?.pendingPostCompactionDelegates).toBeUndefined();
    });
  });

  it("queues persisted delegates before staged delegates and starts a drain", async () => {
    const sessionEntry: SessionEntry = {
      sessionId: "session",
      updatedAt: 1,
      continuationChainCount: 3,
      pendingPostCompactionDelegates: [delegate("persisted")],
    };
    const preserve: SessionPostCompactionDelegate[] = [];
    const {
      deps,
      drainPostCompactionDelegateDeliveries,
      enqueuePostCompactionDelegateDelivery,
      enqueueSystemEvent,
    } = createDispatchDeps({
      staged: [delegate("staged")],
      context: "[context] refreshed",
    });

    const result = await dispatchPostCompactionDelegates(
      {
        cfg,
        compactionCount: 7,
        followupRun: createFollowupRun({
          originatingChannel: "discord",
          originatingAccountId: "account",
          originatingTo: "channel",
          originatingThreadId: "thread",
        }),
        postCompactionDelegatesToPreserve: preserve,
        sessionEntry,
        sessionKey: "main",
      },
      deps,
    );
    await flushMicrotasks();

    expect(result).toEqual({ queuedDelegates: 2, droppedDelegates: 0 });
    expect(sessionEntry.continuationChainCount).toBe(3);
    expect(enqueuePostCompactionDelegateDelivery).toHaveBeenCalledTimes(2);
    expect(enqueuePostCompactionDelegateDelivery.mock.calls.map((call) => call[0])).toEqual([
      {
        sessionKey: "main",
        delegate: normalizePostCompactionDelegate(delegate("persisted")),
        sequence: 0,
        compactionCount: 7,
        deliveryContext: {
          channel: "discord",
          to: "channel",
          accountId: "account",
          threadId: "thread",
        },
      },
      {
        sessionKey: "main",
        delegate: normalizePostCompactionDelegate(delegate("staged")),
        sequence: 1,
        compactionCount: 7,
        deliveryContext: {
          channel: "discord",
          to: "channel",
          accountId: "account",
          threadId: "thread",
        },
      },
    ]);
    expect(drainPostCompactionDelegateDeliveries).toHaveBeenCalledWith({
      log: expect.any(Object),
      sessionKey: "main",
    });
    expect(enqueueSystemEvent).toHaveBeenCalledWith("[context] refreshed", {
      sessionKey: "main",
    });
    expect(enqueueSystemEvent).toHaveBeenCalledWith(
      expect.stringContaining(
        "Queued 2 post-compaction delegate(s) for delivery into the fresh session.",
      ),
      { sessionKey: "main" },
    );
    expect(preserve).toEqual([]);
  });

  it("surfaces post-compaction context read failures to the fresh session", async () => {
    const sessionEntry: SessionEntry = { sessionId: "session", updatedAt: 1 };
    const { deps, enqueueSystemEvent, log } = createDispatchDeps({
      contextError: new Error("workspace locked"),
    });

    await dispatchPostCompactionDelegates(
      {
        cfg,
        compactionCount: 1,
        followupRun: createFollowupRun(),
        postCompactionDelegatesToPreserve: [],
        sessionEntry,
        sessionKey: "main",
      },
      deps,
    );
    await flushMicrotasks();

    expect(log).toHaveBeenCalledWith(
      "[continuation:post-compaction-context-read-failed] sessionKey=main error=workspace locked",
    );
    expect(enqueueSystemEvent).toHaveBeenCalledWith(
      expect.stringContaining("Context evacuation read failed: workspace locked"),
      { sessionKey: "main" },
    );
  });

  it("surfaces persisted post-compaction delegate load failures without clearing local pending delegates", async () => {
    await withTempDir({ prefix: "openclaw-post-compaction-dispatch-fail-" }, async (tempDir) => {
      const storePath = tempDir;
      const sessionEntry: SessionEntry = {
        sessionId: "session",
        updatedAt: 1,
        pendingPostCompactionDelegates: [delegate("persisted")],
      };
      const { deps, enqueueSystemEvent, log } = createDispatchDeps();

      const result = await dispatchPostCompactionDelegates(
        {
          cfg,
          compactionCount: 1,
          followupRun: createFollowupRun(),
          postCompactionDelegatesToPreserve: [],
          sessionEntry,
          sessionKey: "main",
          storePath,
        },
        deps,
      );

      expect(result).toEqual({ queuedDelegates: 0, droppedDelegates: 0 });
      expect(sessionEntry.pendingPostCompactionDelegates).toEqual([delegate("persisted")]);
      expect(log).toHaveBeenCalledWith(
        expect.stringContaining("Failed to load post-compaction delegates for main:"),
      );
      expect(enqueueSystemEvent).toHaveBeenCalledWith(
        expect.stringContaining(
          "Failed to load persisted post-compaction delegates for this session:",
        ),
        { sessionKey: "main" },
      );
    });
  });

  it("caps queued delegates at maxDelegatesPerTurn and drops the overflow", async () => {
    const sessionEntry: SessionEntry = { sessionId: "session", updatedAt: 1 };
    const preserve: SessionPostCompactionDelegate[] = [];
    const { deps, enqueuePostCompactionDelegateDelivery, log } = createDispatchDeps({
      staged: [
        delegate("a"),
        delegate("b"),
        delegate("c"),
        delegate("d"),
        delegate("e"),
        delegate("f"),
        delegate("g"),
      ],
      runtimeConfig: { ...defaultRuntimeConfig, maxDelegatesPerTurn: 5 },
    });

    const result = await dispatchPostCompactionDelegates(
      {
        cfg,
        compactionCount: 1,
        followupRun: createFollowupRun(),
        postCompactionDelegatesToPreserve: preserve,
        sessionEntry,
        sessionKey: "main",
      },
      deps,
    );

    expect(result).toEqual({ queuedDelegates: 5, droppedDelegates: 2 });
    expect(enqueuePostCompactionDelegateDelivery).toHaveBeenCalledTimes(5);
    expect(
      enqueuePostCompactionDelegateDelivery.mock.calls.map((call) => call[0].delegate.task),
    ).toEqual(["a", "b", "c", "d", "e"]);
    expect(log).toHaveBeenCalledWith(
      expect.stringContaining("2 over maxDelegatesPerTurn budget (5, bracketOffset=0)"),
    );
    expect(preserve).toEqual([]);
  });

  it("drops stale delegates using stable firstArmedAt age", async () => {
    const now = 1_700_000_000_000;
    const staleFirstArmedAt = now - 8 * 24 * 60 * 60 * 1000;
    const sessionEntry: SessionEntry = { sessionId: "session", updatedAt: 1 };
    const preserve: SessionPostCompactionDelegate[] = [];
    const { deps, enqueuePostCompactionDelegateDelivery, log } = createDispatchDeps({
      staged: [
        delegate("stale", {
          createdAt: now,
          firstArmedAt: staleFirstArmedAt,
        }),
        delegate("fresh", {
          createdAt: now,
          firstArmedAt: now - 60_000,
        }),
      ],
      now,
    });

    const result = await dispatchPostCompactionDelegates(
      {
        cfg,
        compactionCount: 1,
        followupRun: createFollowupRun(),
        postCompactionDelegatesToPreserve: preserve,
        sessionEntry,
        sessionKey: "main",
      },
      deps,
    );

    expect(result).toEqual({ queuedDelegates: 1, droppedDelegates: 1 });
    expect(enqueuePostCompactionDelegateDelivery).toHaveBeenCalledTimes(1);
    expect(enqueuePostCompactionDelegateDelivery.mock.calls[0]?.[0].delegate).toMatchObject({
      task: "fresh",
      firstArmedAt: now - 60_000,
    });
    expect(log).toHaveBeenCalledWith(
      expect.stringContaining("Post-compaction delegate dropped as stale for main"),
    );
    expect(log).toHaveBeenCalledWith(expect.stringContaining(`firstArmedAt=${staleFirstArmedAt}`));
  });

  it("reduces compaction budget by one when a bracket delegate was already spawned this turn", async () => {
    const sessionEntry: SessionEntry = { sessionId: "session", updatedAt: 1 };
    const preserve: SessionPostCompactionDelegate[] = [];
    const { deps, enqueuePostCompactionDelegateDelivery } = createDispatchDeps({
      staged: [delegate("a"), delegate("b"), delegate("c"), delegate("d"), delegate("e")],
      runtimeConfig: { ...defaultRuntimeConfig, maxDelegatesPerTurn: 5 },
    });

    const result = await dispatchPostCompactionDelegates(
      {
        cfg,
        compactionCount: 1,
        continuationSignalKind: "delegate",
        followupRun: createFollowupRun(),
        postCompactionDelegatesToPreserve: preserve,
        sessionEntry,
        sessionKey: "main",
      },
      deps,
    );

    expect(result).toEqual({ queuedDelegates: 4, droppedDelegates: 1 });
    expect(enqueuePostCompactionDelegateDelivery).toHaveBeenCalledTimes(4);
  });

  it("does not enqueue any delegate when the bracket offset zeros the budget", async () => {
    const sessionEntry: SessionEntry = { sessionId: "session", updatedAt: 1 };
    const preserve: SessionPostCompactionDelegate[] = [];
    const { deps, enqueuePostCompactionDelegateDelivery } = createDispatchDeps({
      staged: [delegate("a"), delegate("b")],
      runtimeConfig: { ...defaultRuntimeConfig, maxDelegatesPerTurn: 1 },
    });

    const result = await dispatchPostCompactionDelegates(
      {
        cfg,
        compactionCount: 1,
        continuationSignalKind: "delegate",
        followupRun: createFollowupRun(),
        postCompactionDelegatesToPreserve: preserve,
        sessionEntry,
        sessionKey: "main",
      },
      deps,
    );

    expect(result).toEqual({ queuedDelegates: 0, droppedDelegates: 2 });
    expect(enqueuePostCompactionDelegateDelivery).not.toHaveBeenCalled();
  });

  it("re-stages delegates when queue enqueue fails", async () => {
    const sessionEntry: SessionEntry = { sessionId: "session", updatedAt: 1 };
    const preserve: SessionPostCompactionDelegate[] = [];
    const { deps, log } = createDispatchDeps({
      staged: [delegate("first"), delegate("second")],
      rejectEnqueueAt: 1,
    });

    const result = await dispatchPostCompactionDelegates(
      {
        cfg,
        compactionCount: 1,
        followupRun: createFollowupRun(),
        postCompactionDelegatesToPreserve: preserve,
        sessionEntry,
        sessionKey: "main",
      },
      deps,
    );

    expect(result).toEqual({ queuedDelegates: 1, droppedDelegates: 1 });
    expect(sessionEntry.pendingPostCompactionDelegates).toEqual([
      normalizePostCompactionDelegate(delegate("second")),
    ]);
    expect(preserve).toEqual([]);
    expect(log).toHaveBeenCalledWith(
      "Failed to enqueue post-compaction delegate for main (re-staged): Error: queue write failed",
    );
  });

  it("uses the fallback workspace resolver only when the run workspace is blank", async () => {
    const { deps, readPostCompactionContext, resolveAgentWorkspaceDir } = createDispatchDeps();

    await dispatchPostCompactionDelegates(
      {
        cfg,
        compactionCount: 1,
        followupRun: createFollowupRun({ workspaceDir: "   " }),
        postCompactionDelegatesToPreserve: [],
        sessionEntry: { sessionId: "session", updatedAt: 1 },
        sessionKey: "main",
      },
      deps,
    );

    expect(resolveAgentWorkspaceDir).toHaveBeenCalledWith(cfg, "main");
    expect(readPostCompactionContext).toHaveBeenCalledWith("/fallback-workspace", {
      cfg,
      agentId: "main",
    });
  });

  it("charges chain count only after queued delivery spawns successfully", async () => {
    await withTempDir({ prefix: "openclaw-post-compaction-delivery-" }, async (tempDir) => {
      const storePath = path.join(tempDir, "sessions.json");
      await fs.writeFile(
        storePath,
        JSON.stringify({ main: { sessionId: "session", updatedAt: Date.now() } }, null, 2),
        "utf-8",
      );
      const { deps, enqueueSystemEvent, spawnSubagentDirect } = createDeliveryDeps({ storePath });

      await deliverQueuedPostCompactionDelegate(
        {
          entry: createQueuedEntry({
            deliveryContext: {
              channel: "discord",
              to: "channel",
              accountId: "account",
              threadId: "thread",
            },
          }),
        },
        deps,
      );

      const stored = JSON.parse(await fs.readFile(storePath, "utf-8")) as Record<
        string,
        SessionEntry
      >;
      expect(Object.values(stored).some((entry) => entry.continuationChainCount === 1)).toBe(true);
      expect(spawnSubagentDirect).toHaveBeenCalledWith(
        expect.objectContaining({
          task: "[continuation:post-compaction] [continuation:chain-hop:1] Compaction just completed. Carry this working state to the post-compaction session: queued delegate",
          silentAnnounce: true,
          wakeOnReturn: true,
          drainsContinuationDelegateQueue: true,
        }),
        {
          agentSessionKey: "main",
          agentChannel: "discord",
          agentAccountId: "account",
          agentTo: "channel",
          agentThreadId: "thread",
        },
      );
      expect(enqueueSystemEvent).toHaveBeenCalledWith(
        "[continuation:compaction-delegate-spawned] Post-compaction shard dispatched: queued delegate",
        { sessionKey: "main" },
      );
    });
  });

  it("preserves traceparent when queued post-compaction replay spawns a child", async () => {
    await withTempDir({ prefix: "openclaw-post-compaction-delivery-" }, async (tempDir) => {
      const storePath = path.join(tempDir, "sessions.json");
      const traceparent = "00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01";
      await fs.writeFile(
        storePath,
        JSON.stringify({ main: { sessionId: "session", updatedAt: Date.now() } }, null, 2),
        "utf-8",
      );
      const { deps, enqueueSystemEvent, spawnSubagentDirect } = createDeliveryDeps({ storePath });

      await deliverQueuedPostCompactionDelegate(
        {
          entry: createQueuedEntry({ traceparent }),
        },
        deps,
      );

      expect(spawnSubagentDirect).toHaveBeenCalledWith(
        expect.objectContaining({ traceparent }),
        expect.any(Object),
      );
      expect(enqueueSystemEvent).toHaveBeenCalledWith(
        "[continuation:compaction-delegate-spawned] Post-compaction shard dispatched: queued delegate",
        { sessionKey: "main", traceparent },
      );
    });
  });

  it("does not charge chain count when queued spawn fails", async () => {
    await withTempDir({ prefix: "openclaw-post-compaction-delivery-" }, async (tempDir) => {
      const storePath = path.join(tempDir, "sessions.json");
      await fs.writeFile(
        storePath,
        JSON.stringify({ main: { sessionId: "session", updatedAt: Date.now() } }, null, 2),
        "utf-8",
      );
      const { deps } = createDeliveryDeps({
        storePath,
        spawnError: new Error("spawn unavailable"),
      });

      await expect(
        deliverQueuedPostCompactionDelegate({ entry: createQueuedEntry() }, deps),
      ).rejects.toThrow("spawn unavailable");

      const stored = JSON.parse(await fs.readFile(storePath, "utf-8")) as Record<
        string,
        SessionEntry
      >;
      expect(Object.values(stored).some((entry) => entry.continuationChainCount != null)).toBe(
        false,
      );
    });
  });

  it("rejects queued delivery when the compaction chain length is already capped", async () => {
    await withTempDir({ prefix: "openclaw-post-compaction-delivery-" }, async (tempDir) => {
      const storePath = path.join(tempDir, "sessions.json");
      await fs.writeFile(
        storePath,
        JSON.stringify(
          { main: { sessionId: "session", updatedAt: 1, continuationChainCount: 2 } },
          null,
          2,
        ),
        "utf-8",
      );
      const { deps, enqueueSystemEvent, log, spawnSubagentDirect } = createDeliveryDeps({
        storePath,
        runtimeConfig: { maxChainLength: 2 },
      });

      await deliverQueuedPostCompactionDelegate({ entry: createQueuedEntry() }, deps);

      expect(spawnSubagentDirect).not.toHaveBeenCalled();
      expect(log).toHaveBeenCalledWith(
        "Post-compaction delegate rejected: chain length 2 >= 2 for session main",
      );
      expect(enqueueSystemEvent).toHaveBeenCalledWith(
        "[continuation] Post-compaction delegate rejected: chain length 2 reached. Task: queued delegate",
        { sessionKey: "main" },
      );
    });
  });

  it("rejects queued delivery when continuation tokens exceed the cost cap", async () => {
    await withTempDir({ prefix: "openclaw-post-compaction-delivery-" }, async (tempDir) => {
      const storePath = path.join(tempDir, "sessions.json");
      await fs.writeFile(
        storePath,
        JSON.stringify(
          { main: { sessionId: "session", updatedAt: 1, continuationChainTokens: 11 } },
          null,
          2,
        ),
        "utf-8",
      );
      const { deps, enqueueSystemEvent, log, spawnSubagentDirect } = createDeliveryDeps({
        storePath,
        runtimeConfig: { costCapTokens: 10 },
      });

      await deliverQueuedPostCompactionDelegate({ entry: createQueuedEntry() }, deps);

      expect(spawnSubagentDirect).not.toHaveBeenCalled();
      expect(log).toHaveBeenCalledWith(
        "Post-compaction delegate rejected: cost cap exceeded (11 > 10) for session main",
      );
      expect(enqueueSystemEvent).toHaveBeenCalledWith(
        "[continuation] Post-compaction delegate rejected: cost cap exceeded (11 > 10). Task: queued delegate",
        { sessionKey: "main" },
      );
    });
  });

  // ---- Regression tests for queue-model correctness repairs ----

  it("drains unfiltered for sessionKey so prior failed entries are reconsidered", async () => {
    const sessionEntry: SessionEntry = { sessionId: "session", updatedAt: 1 };
    const preserve: SessionPostCompactionDelegate[] = [];
    const { deps, drainPostCompactionDelegateDeliveries } = createDispatchDeps({
      staged: [delegate("fresh")],
    });

    await dispatchPostCompactionDelegates(
      {
        cfg,
        compactionCount: 1,
        followupRun: createFollowupRun(),
        postCompactionDelegatesToPreserve: preserve,
        sessionEntry,
        sessionKey: "main",
      },
      deps,
    );
    await flushMicrotasks();

    expect(drainPostCompactionDelegateDeliveries).toHaveBeenCalledTimes(1);
    const calls = drainPostCompactionDelegateDeliveries.mock.calls as ReadonlyArray<
      ReadonlyArray<unknown>
    >;
    const callArg = calls[0]?.[0] as Record<string, unknown> | undefined;
    expect(callArg).toBeDefined();
    // Must omit entryIds so the drain is sessionKey-scoped and
    // backoff-eligible (no bypass), rescuing prior failed pending entries.
    expect(callArg).not.toHaveProperty("entryIds");
    expect(callArg).toMatchObject({ sessionKey: "main" });
  });

  it("propagates chain-state persist failures so the queue entry retries", async () => {
    await withTempDir({ prefix: "openclaw-post-compaction-persist-fail-" }, async (tempDir) => {
      const storePath = path.join(tempDir, "sessions.json");
      await fs.writeFile(
        storePath,
        JSON.stringify({ main: { sessionId: "session", updatedAt: 1 } }, null, 2),
        "utf-8",
      );
      const { deps, log, spawnSubagentDirect } = createDeliveryDeps({ storePath });

      // Block atomic write: chmod parent dir to 0o500 so writeTextAtomic
      // cannot create the temp file. The initial deps.loadSessionStore
      // mock reads from disk before this is hit, so the spawn occurs and
      // the post-spawn persist is what fails.
      await fs.chmod(tempDir, 0o500);
      try {
        await expect(
          deliverQueuedPostCompactionDelegate({ entry: createQueuedEntry() }, deps),
        ).rejects.toBeDefined();
      } finally {
        await fs.chmod(tempDir, 0o700);
      }

      expect(spawnSubagentDirect).toHaveBeenCalledTimes(1);
      expect(log).toHaveBeenCalledWith(
        expect.stringContaining("Failed to persist post-compaction delegate chain state for main"),
      );
    });
  });

  it("reports queuedDelegates count (not delivered count) in the lifecycle event", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-04-26T22:30:00.000Z"));

    const sessionEntry: SessionEntry = { sessionId: "session", updatedAt: 1 };
    const preserve: SessionPostCompactionDelegate[] = [];
    const { deps, enqueueSystemEvent } = createDispatchDeps({
      staged: [delegate("a"), delegate("b"), delegate("c")],
    });

    const result = await dispatchPostCompactionDelegates(
      {
        cfg,
        compactionCount: 4,
        followupRun: createFollowupRun(),
        postCompactionDelegatesToPreserve: preserve,
        sessionEntry,
        sessionKey: "main",
      },
      deps,
    );
    await flushMicrotasks();

    expect(result).toEqual({ queuedDelegates: 3, droppedDelegates: 0 });
    expect(enqueueSystemEvent).toHaveBeenCalledWith(
      "[system:post-compaction] Session compacted at 2026-04-26T22:30:00.000Z. Compaction count: 4. Queued 3 post-compaction delegate(s) for delivery into the fresh session.",
      { sessionKey: "main" },
    );
  });
});
