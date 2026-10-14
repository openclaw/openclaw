import path from "node:path";
import { afterAll, describe, expect, it, vi } from "vitest";
import { AgentHarnessSessionCleanupError } from "../../agents/harness/errors.js";
import { registerAgentHarness } from "../../agents/harness/registry.js";
import {
  loadSessionEntry,
  upsertSessionEntryCore,
} from "../../config/sessions/session-accessor.js";
import { replaceSessionEntrySync } from "../../config/sessions/session-accessor.sqlite-entry.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { createEmptyPluginRegistry } from "../../plugins/registry-empty.js";
import { withPluginRuntimeRegistryScope } from "../../plugins/runtime/gateway-request-scope.js";
import { useSessionStoreTempDirs } from "../../test-utils/session-state-cleanup.js";
import { finalizeInboundContext } from "./inbound-context.js";
import {
  ReplySessionInitConflictError,
  runWithSessionInitConflictRetry,
} from "./session-init-conflict-retry.js";
import { initSessionState as initSessionStateRaw } from "./session.js";

const initSessionState = (
  params: Omit<Parameters<typeof initSessionStateRaw>[0], "ctx"> & {
    ctx: Record<string, unknown>;
  },
) => initSessionStateRaw({ ...params, ctx: finalizeInboundContext(params.ctx) });

const commitConflictControl = vi.hoisted(() => ({
  abortController: undefined as AbortController | undefined,
  beforeEntryMutation: undefined as
    | ((params: { sessionKey: string; storePath: string }) => Promise<void> | void)
    | undefined,
  commitCalls: 0,
  remainingFailures: 0,
}));

vi.mock("../../config/sessions/session-accessor.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../config/sessions/session-accessor.js")>();
  return {
    ...actual,
    commitReplySessionInitialization: async (
      ...args: Parameters<typeof actual.commitReplySessionInitialization>
    ) => {
      commitConflictControl.commitCalls += 1;
      if (commitConflictControl.remainingFailures > 0) {
        commitConflictControl.remainingFailures -= 1;
        if (commitConflictControl.remainingFailures === 0) {
          setImmediate(() =>
            commitConflictControl.abortController?.abort(new Error("cancel session init")),
          );
        }
        return {
          ok: false as const,
          reason: "stale-snapshot" as const,
          revision: `forced-conflict-${commitConflictControl.commitCalls}`,
        };
      }
      const [params] = args;
      const beforeEntryMutation = commitConflictControl.beforeEntryMutation;
      return await actual.commitReplySessionInitialization({
        ...params,
        ...(beforeEntryMutation
          ? {
              beforeEntryMutation: async (context) => {
                await params.beforeEntryMutation?.(context);
                await beforeEntryMutation({
                  sessionKey: params.sessionKey,
                  storePath: params.storePath,
                });
              },
            }
          : {}),
      });
    },
  };
});

const SESSION_KEY = "agent:main:dashboard:test";

function conflictingAttempt(failures: number) {
  const state = { calls: 0 };
  const attempt = async () => {
    state.calls += 1;
    if (state.calls <= failures) {
      throw new ReplySessionInitConflictError(SESSION_KEY);
    }
    return "ok" as const;
  };
  return { attempt, state };
}

const instantSleep = async (_ms: number) => {};

describe("runWithSessionInitConflictRetry", () => {
  it("retries conflict messages rejected as strings", async () => {
    const attempt = vi
      .fn<() => Promise<string>>()
      .mockRejectedValueOnce(`reply session initialization conflicted for ${SESSION_KEY}`)
      .mockResolvedValue("ok");

    await expect(runWithSessionInitConflictRetry(attempt, { sleep: instantSleep })).resolves.toBe(
      "ok",
    );
    expect(attempt).toHaveBeenCalledTimes(2);
  });

  it("executes an attempt after every caller-provided retry delay", async () => {
    const { attempt, state } = conflictingAttempt(3);
    const delays: number[] = [];
    await expect(
      runWithSessionInitConflictRetry(attempt, {
        retryDelaysMs: [1, 2, 3],
        sleep: async (ms) => {
          delays.push(ms);
        },
      }),
    ).resolves.toBe("ok");
    expect(state.calls).toBe(4);
    expect(delays).toEqual([1, 2, 3]);
  });

  it("does not retry non-conflict errors", async () => {
    let calls = 0;
    const attempt = async () => {
      calls += 1;
      throw new Error("reply session initialization aborted");
    };
    await expect(runWithSessionInitConflictRetry(attempt, { sleep: instantSleep })).rejects.toThrow(
      "reply session initialization aborted",
    );
    expect(calls).toBe(1);
  });

  it("stops retrying when the abort signal fires", async () => {
    const controller = new AbortController();
    let calls = 0;
    const attempt = async () => {
      calls += 1;
      controller.abort();
      throw new ReplySessionInitConflictError(SESSION_KEY);
    };
    await expect(
      runWithSessionInitConflictRetry(attempt, {
        signal: controller.signal,
        sleep: instantSleep,
      }),
    ).rejects.toBeInstanceOf(ReplySessionInitConflictError);
    expect(calls).toBe(1);
  });

  it("applies capped exponential backoff between attempts", async () => {
    const delays: number[] = [];
    const { attempt, state } = conflictingAttempt(Number.POSITIVE_INFINITY);
    const randomSpy = vi.spyOn(Math, "random").mockReturnValue(0);
    try {
      await expect(
        runWithSessionInitConflictRetry(attempt, {
          sleep: async (ms) => {
            delays.push(ms);
          },
        }),
      ).rejects.toBeInstanceOf(ReplySessionInitConflictError);
      expect(state.calls).toBe(5);
      expect(delays).toEqual([250, 500, 1_000, 2_000]);
    } finally {
      randomSpy.mockRestore();
    }
  });
});

describe("initSessionState conflict retry wiring", () => {
  const sessionDirs = useSessionStoreTempDirs(afterAll, "openclaw-session-late-conflict-");
  it("preserves the session generation when registered mandatory cleanup fails, then retries", async () => {
    const storePath = path.join(sessionDirs.make(), "sessions.json");
    const registry = createEmptyPluginRegistry();
    const failure = new AgentHarnessSessionCleanupError("native session still running");
    let cleanupAvailable = false;
    await upsertSessionEntryCore(
      { sessionKey: SESSION_KEY, storePath },
      {
        sessionId: "cleanup-blocked-session",
        lifecycleRevision: "cleanup-original-revision",
        updatedAt: Date.now() - 86_400_000,
      },
    );
    const readSession = () =>
      loadSessionEntry({ readConsistency: "latest", sessionKey: SESSION_KEY, storePath });
    const original = readSession();
    await withPluginRuntimeRegistryScope(registry, async () => {
      registerAgentHarness({
        id: "required-cleanup",
        label: "Required cleanup",
        supports: () => ({ supported: false }),
        runAttempt: async () => {
          throw new Error("not used");
        },
        reset: async () => {
          if (!cleanupAvailable) {
            throw failure;
          }
        },
      });
      const initialize = () =>
        initSessionState({
          cfg: { session: { store: storePath, reset: { mode: "idle", idleMinutes: 30 } } },
          commandAuthorized: true,
          ctx: { Body: "/new", SessionKey: SESSION_KEY },
        });
      await expect(initialize()).rejects.toBe(failure);
      expect(readSession()).toEqual(original);
      cleanupAvailable = true;
      const resumed = await initialize();
      expect(resumed.isNewSession).toBe(true);
      expect(readSession()).toMatchObject({
        sessionId: resumed.sessionId,
        lifecycleRevision: resumed.sessionEntry.lifecycleRevision,
      });
      expect(resumed.sessionEntry.lifecycleRevision).not.toBe(original?.lifecycleRevision);
    });
  });

  it("retries a late same-session lifecycle conflict without losing either update", async () => {
    const root = sessionDirs.make();
    const storePath = path.join(root, "sessions.json");
    let lateWrites = 0;
    commitConflictControl.commitCalls = 0;
    commitConflictControl.beforeEntryMutation = ({ sessionKey, storePath: targetStorePath }) => {
      if (lateWrites >= 2) {
        return;
      }
      const currentEntry = loadSessionEntry({
        readConsistency: "latest",
        sessionKey,
        storePath: targetStorePath,
      });
      if (!currentEntry) {
        throw new Error("expected the projected reply session row");
      }
      lateWrites += 1;
      replaceSessionEntrySync(
        { sessionKey, storePath: targetStorePath },
        {
          ...currentEntry,
          lastHeartbeatSentAt: 100 + lateWrites,
          lastHeartbeatText: `concurrent metadata ${lateWrites}`,
        },
      );
      if (lateWrites === 2) {
        commitConflictControl.beforeEntryMutation = undefined;
      }
    };

    try {
      await upsertSessionEntryCore(
        { sessionKey: SESSION_KEY, storePath },
        // No display name seeded: the derived thread label may only initialize an
        // unnamed session, and this test tracks the init write surviving retries.
        {
          sessionId: "existing-session",
          updatedAt: Date.now(),
        },
      );

      const result = await initSessionState({
        cfg: { session: { store: storePath } } as OpenClawConfig,
        commandAuthorized: true,
        ctx: {
          Body: "hello",
          SessionKey: SESSION_KEY,
          ThreadLabel: "reply initialization update",
        },
      });

      expect(commitConflictControl.commitCalls).toBe(3);
      expect(lateWrites).toBe(2);
      expect(result.sessionEntry).toMatchObject({
        displayName: "reply initialization update",
        lastHeartbeatSentAt: 102,
        lastHeartbeatText: "concurrent metadata 2",
        sessionId: "existing-session",
      });
      expect(
        loadSessionEntry({ readConsistency: "latest", sessionKey: SESSION_KEY, storePath }),
      ).toMatchObject({
        displayName: "reply initialization update",
        lastHeartbeatSentAt: 102,
        lastHeartbeatText: "concurrent metadata 2",
        sessionId: "existing-session",
      });
    } finally {
      commitConflictControl.beforeEntryMutation = undefined;
    }
  });

  it("cancels the production backoff through the initializer signal", async () => {
    const root = sessionDirs.make();
    const controller = new AbortController();
    commitConflictControl.abortController = controller;
    commitConflictControl.commitCalls = 0;
    commitConflictControl.remainingFailures = 2;

    try {
      const initializing = initSessionState({
        cfg: { session: { store: path.join(root, "sessions.json") } } as OpenClawConfig,
        commandAuthorized: true,
        ctx: {
          Body: "hello",
          SessionKey: SESSION_KEY,
        },
        signal: controller.signal,
      });

      await expect(initializing).rejects.toThrow("aborted");
      expect(commitConflictControl.commitCalls).toBe(2);
    } finally {
      commitConflictControl.abortController = undefined;
      commitConflictControl.remainingFailures = 0;
    }
  });
});
