import path from "node:path";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { AgentHarnessSessionCleanupError } from "../../agents/harness/errors.js";
import { registerAgentHarness } from "../../agents/harness/registry.js";
import {
  loadSessionEntry,
  upsertSessionEntryCore,
} from "../../config/sessions/session-accessor.js";
import { replaceSessionEntrySync } from "../../config/sessions/session-accessor.sqlite-entry.js";
import { createEmptyPluginRegistry } from "../../plugins/registry-empty.js";
import { withPluginRuntimeRegistryScope } from "../../plugins/runtime/gateway-request-scope.js";
import { useSessionStoreTempDirs } from "../../test-utils/session-state-cleanup.js";
import { finalizeInboundContext } from "./inbound-context.js";
import {
  ReplySessionInitConflictError,
  runWithSessionInitConflictRetry,
} from "./session-init-conflict-retry.js";
import { initSessionState as initSessionStateRaw } from "./session.js";

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
      const options = { ...params };
      if (beforeEntryMutation) {
        options.beforeEntryMutation = async (context) => {
          await params.beforeEntryMutation?.(context);
          await beforeEntryMutation(params);
        };
      }
      return await actual.commitReplySessionInitialization(options);
    },
  };
});

const SESSION_KEY = "agent:main:dashboard:test";

function conflictingAttempt(failures: number) {
  let calls = 0;
  return vi.fn(async () => {
    if (++calls <= failures) {
      throw new ReplySessionInitConflictError(SESSION_KEY);
    }
    return "ok" as const;
  });
}

const instantSleep = async (_ms: number) => {};

afterEach(() => {
  vi.restoreAllMocks();
  Object.assign(commitConflictControl, {
    abortController: undefined,
    beforeEntryMutation: undefined,
    commitCalls: 0,
    remainingFailures: 0,
  });
});

describe("runWithSessionInitConflictRetry", () => {
  it.each([
    [
      "retries string conflicts",
      `reply session initialization conflicted for ${SESSION_KEY}`,
      false,
      2,
    ],
    ["does not retry other errors", new Error("reply session initialization aborted"), false, 1],
    ["stops on abort", new ReplySessionInitConflictError(SESSION_KEY), true, 1],
  ] as const)("%s", async (_name, error, abort, calls) => {
    const controller = new AbortController();
    const attempt = vi
      .fn<() => Promise<string>>()
      .mockImplementationOnce(async () => {
        if (abort) {
          controller.abort();
        }
        throw error;
      })
      .mockResolvedValue("ok");
    const result = expect(
      runWithSessionInitConflictRetry(attempt, {
        signal: controller.signal,
        sleep: instantSleep,
      }),
    );
    if (calls === 2) {
      await result.resolves.toBe("ok");
    } else {
      await result.rejects.toBe(error);
    }
    expect(attempt).toHaveBeenCalledTimes(calls);
  });

  it.each([
    ["caller delays", 3, [1, 2, 3], [1, 2, 3]],
    ["capped exponential backoff", Infinity, undefined, [250, 500, 1_000, 2_000]],
  ] as const)("applies %s between attempts", async (_name, failures, retryDelaysMs, expected) => {
    const attempt = conflictingAttempt(failures);
    const delays: number[] = [];
    vi.spyOn(Math, "random").mockReturnValue(0);
    const result = expect(
      runWithSessionInitConflictRetry(attempt, {
        retryDelaysMs,
        sleep: async (ms) => {
          delays.push(ms);
        },
      }),
    );
    if (retryDelaysMs) {
      await result.resolves.toBe("ok");
    } else {
      await result.rejects.toBeInstanceOf(ReplySessionInitConflictError);
    }
    expect(attempt).toHaveBeenCalledTimes(expected.length + 1);
    expect(delays).toEqual(expected);
  });
});

describe("initSessionState conflict retry wiring", () => {
  const sessionDirs = useSessionStoreTempDirs(afterAll, "openclaw-session-late-conflict-");
  function fixture() {
    const scope = {
      sessionKey: SESSION_KEY,
      storePath: path.join(sessionDirs.make(), "sessions.json"),
    };
    return {
      ...scope,
      read: () => loadSessionEntry({ ...scope, readConsistency: "latest" }),
      seed: (entry: Parameters<typeof upsertSessionEntryCore>[1]) =>
        upsertSessionEntryCore(scope, entry),
      initialize: ({
        ctx = {},
        ...params
      }: Partial<Omit<Parameters<typeof initSessionStateRaw>[0], "ctx">> & {
        ctx?: Record<string, unknown>;
      } = {}) =>
        initSessionStateRaw({
          cfg: { session: { store: scope.storePath } },
          commandAuthorized: true,
          ctx: finalizeInboundContext({ Body: "hello", SessionKey: SESSION_KEY, ...ctx }),
          ...params,
        }),
    };
  }
  it("preserves the session generation when registered mandatory cleanup fails, then retries", async () => {
    const { storePath, read: readSession, initialize, seed } = fixture();
    const registry = createEmptyPluginRegistry();
    const failure = new AgentHarnessSessionCleanupError("native session still running");
    let cleanupAvailable = false;
    await seed({
      sessionId: "cleanup-blocked-session",
      lifecycleRevision: "cleanup-original-revision",
      updatedAt: Date.now() - 86_400_000,
    });
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
      const reset = () =>
        initialize({
          cfg: { session: { store: storePath, reset: { mode: "idle", idleMinutes: 30 } } },
          ctx: { Body: "/new" },
        });
      await expect(reset()).rejects.toBe(failure);
      expect(readSession()).toEqual(original);
      cleanupAvailable = true;
      const resumed = await reset();
      expect(resumed.isNewSession).toBe(true);
      expect(readSession()).toMatchObject({
        sessionId: resumed.sessionId,
        lifecycleRevision: resumed.sessionEntry.lifecycleRevision,
      });
      expect(resumed.sessionEntry.lifecycleRevision).not.toBe(original?.lifecycleRevision);
    });
  });

  it("retries a late same-session lifecycle conflict without losing either update", async () => {
    const { read, initialize, seed } = fixture();
    let lateWrites = 0;
    commitConflictControl.beforeEntryMutation = (scope) => {
      if (lateWrites >= 2) {
        return;
      }
      const currentEntry = loadSessionEntry({ ...scope, readConsistency: "latest" });
      if (!currentEntry) {
        throw new Error("expected the projected reply session row");
      }
      lateWrites += 1;
      replaceSessionEntrySync(scope, {
        ...currentEntry,
        lastHeartbeatSentAt: 100 + lateWrites,
        lastHeartbeatText: `concurrent metadata ${lateWrites}`,
      });
      if (lateWrites === 2) {
        commitConflictControl.beforeEntryMutation = undefined;
      }
    };

    await seed({ sessionId: "existing-session", updatedAt: Date.now() });

    const result = await initialize({ ctx: { ThreadLabel: "reply initialization update" } });

    expect(commitConflictControl.commitCalls).toBe(3);
    expect(lateWrites).toBe(2);
    const expected = {
      displayName: "reply initialization update",
      lastHeartbeatSentAt: 102,
      lastHeartbeatText: "concurrent metadata 2",
      sessionId: "existing-session",
    };
    expect(result.sessionEntry).toMatchObject(expected);
    expect(read()).toMatchObject(expected);
  });

  it("cancels the production backoff through the initializer signal", async () => {
    const { initialize } = fixture();
    const controller = new AbortController();
    commitConflictControl.abortController = controller;
    commitConflictControl.remainingFailures = 2;

    await expect(initialize({ signal: controller.signal })).rejects.toThrow("aborted");
    expect(commitConflictControl.commitCalls).toBe(2);
  });
});
