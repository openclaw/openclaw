import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import { clearInternalHooks, registerInternalHook } from "../hooks/internal-hooks.js";
import { createHookRunnerWithRegistry } from "../plugins/hooks.test-fixtures.js";
import type { PluginHookSessionContext } from "../plugins/session-end-transcript.js";

const sessionEnd = vi.fn(async (_event: { sessionId?: string }) => undefined);
const hasHooks = vi.fn((name: string) => name === "session_end");
const createMockHookRunner = () => ({
  hasHooks,
  runSessionEnd: sessionEnd,
});
type TestHookRunner =
  | ReturnType<typeof createMockHookRunner>
  | ReturnType<typeof createHookRunnerWithRegistry>["runner"];
const hookRunner = vi.fn<() => TestHookRunner>(() => createMockHookRunner());
const readTranscript = vi.fn();

// mock-isolation: Shutdown uses a fixture hook runner without the global plugin registry.
vi.mock("../plugins/hook-runner-global.js", () => ({
  getGlobalHookRunner: hookRunner,
}));

vi.mock("./session-transcript-files.fs.js", () => ({
  extractGeneratedTranscriptSessionId: vi.fn(() => undefined),
  resolveSessionTranscriptCandidates: vi.fn(() => []),
  resolveStableSessionEndTranscript: vi.fn(() => ({
    sessionFile: undefined,
    transcriptArchived: false,
  })),
  archiveSessionTranscriptsDetailed: vi.fn(() => []),
}));

vi.mock("./session-end-transcript-reader.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./session-end-transcript-reader.js")>()),
  createClosedSessionTranscriptSource: vi.fn(() => ({
    available: true as const,
    readTail: readTranscript,
  })),
}));

const { emitGatewaySessionEndPluginHook: emitEnd, emitGatewaySessionStartPluginHook: emitStart } =
  await import("./session-reset-service.js");
const { drainActiveSessionsForShutdown } = await import("./active-sessions-shutdown-drain.js");
const { forgetActiveSessionForShutdown: forget, listActiveSessionsForShutdown: activeSessions } =
  await import("./active-sessions-shutdown-tracker.js");

const baseSession = {
  cfg: {},
  sessionKey: "agent:main:main",
  storePath: "/tmp/store.json",
  agentId: "main",
};
const session = (sessionId: string, sessionKey = baseSession.sessionKey) => ({
  ...baseSession,
  sessionId,
  sessionKey,
});
const track = (sessionId: string, sessionKey?: string) => emitStart(session(sessionId, sessionKey));
const drain = (totalTimeoutMs?: number) =>
  drainActiveSessionsForShutdown({ reason: "shutdown", totalTimeoutMs });

function cleanup(): void {
  for (const entry of activeSessions()) {
    forget(entry.sessionId);
  }
  clearInternalHooks();
}

beforeEach(() => {
  cleanup();
  sessionEnd.mockClear();
  readTranscript.mockReset();
  hasHooks.mockClear().mockImplementation((name: string) => name === "session_end");
  hookRunner.mockReset().mockImplementation(() => createMockHookRunner());
});

afterEach(cleanup);

describe("drainActiveSessionsForShutdown", () => {
  it.each([
    ["reset", true],
    ["deleted", false],
  ] as const)("forgets finalized sessions (%s, plugins: %s)", async (reason, plugins) => {
    hasHooks.mockImplementation((name) => plugins && name === "session_end");
    track("sess-A");
    if (plugins) {
      track("sess-B", "agent:main:other");
    }
    emitEnd({ ...session("sess-A"), reason });
    sessionEnd.mockClear();
    if (!plugins) {
      expect(activeSessions()).toEqual([]);
    }
    const expected = plugins ? ["sess-B"] : [];
    expect((await drain()).emittedSessionIds).toEqual(expected);
    expect(sessionEnd.mock.calls.map(([event]) => event.sessionId)).toEqual(expected);
  });
  it.each([false, true])(
    "awaits handlers without blocking later emissions (timeout=%s)",
    async (timedOut) => {
      const handler = createDeferred();
      sessionEnd.mockImplementationOnce(async () => {
        await handler.promise;
      });
      track("sess-A");
      track("sess-B", "agent:main:other");
      let drainSettled = false;
      const pending = drain(120).then((value) => {
        drainSettled = true;
        return value;
      });
      // #57790: drain must await the handler, not fire and forget.
      await Promise.resolve();
      await Promise.resolve();
      expect(drainSettled).toBe(false);
      expect(sessionEnd.mock.calls.map(([event]) => event.sessionId)).toEqual(["sess-A", "sess-B"]);
      try {
        if (!timedOut) {
          handler.resolve();
        }
        expect(await pending).toEqual({ timedOut, emittedSessionIds: ["sess-A", "sess-B"] });
      } finally {
        handler.resolve();
        await pending;
      }
    },
  );

  it("revokes shutdown transcript reads when the aggregate drain expires", async () => {
    vi.useFakeTimers();
    const sourceRead = createDeferred<{
      messages: readonly unknown[];
      totalMessages: number;
      truncated: boolean;
    }>();
    const readStarted = createDeferred();
    readTranscript.mockImplementationOnce(() => {
      readStarted.resolve();
      return sourceRead.promise;
    });
    let retainedReader: PluginHookSessionContext["endedTranscript"];
    let inFlightRead: Promise<unknown> | undefined;
    const { runner } = createHookRunnerWithRegistry([
      {
        hookName: "session_end",
        conversationAccessAllowed: true,
        handler: async (_event, context) => {
          const transcript = (context as PluginHookSessionContext).endedTranscript;
          if (!transcript?.available) {
            throw new Error("expected ended transcript reader");
          }
          retainedReader = transcript;
          inFlightRead = transcript.readTail({ maxMessages: 10, maxBytes: 64 * 1_024 });
          await inFlightRead.catch(() => undefined);
        },
      },
    ]);
    hookRunner.mockReturnValue(runner);
    track("sess-A");

    const drainPromise = drain(100);
    await readStarted.promise;
    await vi.advanceTimersByTimeAsync(100);
    await expect(drainPromise).resolves.toMatchObject({ timedOut: true });

    if (!retainedReader?.available || !inFlightRead) {
      throw new Error("expected retained and in-flight transcript reads");
    }
    await expect(retainedReader.readTail({ maxMessages: 1, maxBytes: 1_024 })).rejects.toThrow(
      "no longer active",
    );
    expect(readTranscript).toHaveBeenCalledOnce();

    sourceRead.resolve({ messages: [], totalMessages: 0, truncated: false });
    await expect(inFlightRead).rejects.toThrow("no longer active");
    vi.useRealTimers();
  });

  it("emits session:auto-reset for idle rollover without a session_end plugin", async () => {
    hasHooks.mockImplementation(() => false);
    const listener = vi.fn();
    registerInternalHook("session:auto-reset", listener);

    emitEnd({
      ...session("sess-A"),
      reason: "idle",
      nextSessionId: "sess-B",
    });

    await vi.waitFor(() => expect(listener).toHaveBeenCalledTimes(1));
    expect(sessionEnd).not.toHaveBeenCalled();
    expect(listener.mock.calls[0]?.[0]).toMatchObject({
      type: "session",
      action: "auto-reset",
      sessionKey: "agent:main:main",
      context: {
        reason: "idle",
        nextSessionId: "sess-B",
        sessionEntry: { sessionId: "sess-A" },
      },
    });
  });
});
