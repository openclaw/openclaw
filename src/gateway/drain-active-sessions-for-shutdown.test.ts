import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";

// Regression coverage for #57790: the bounded shutdown drain must fire a
// typed `session_end` for every session the tracker has noted, must skip
// sessions that have already been finalized through replace / reset /
// delete / compaction (so we never double-fire), must respect the
// configured total timeout, and must propagate the reason ("shutdown" or
// "restart") into the plugin hook payload.

const runSessionEndMock = vi.fn(async () => undefined);
const hasHooksMock = vi.fn((name: string) => name === "session_end");
const getGlobalHookRunnerMock = vi.fn(() => ({
  hasHooks: hasHooksMock,
  runSessionEnd: runSessionEndMock,
  runSessionStart: vi.fn(async () => undefined),
}));

vi.mock("../plugins/hook-runner-global.js", () => ({
  getGlobalHookRunner: getGlobalHookRunnerMock,
}));

vi.mock("./session-transcript-files.fs.js", () => ({
  resolveStableSessionEndTranscript: vi.fn(() => ({
    sessionFile: undefined,
    transcriptArchived: false,
  })),
  archiveSessionTranscriptsDetailed: vi.fn(() => []),
}));

vi.mock("../auto-reply/reply/session-hooks.js", () => ({
  buildSessionEndHookPayload: vi.fn(
    (params: { sessionId: string; reason: string; sessionKey: string }) => ({
      event: { sessionId: params.sessionId, reason: params.reason, sessionKey: params.sessionKey },
      context: { sessionId: params.sessionId, reason: params.reason },
    }),
  ),
  buildSessionStartHookPayload: vi.fn(() => ({ event: {}, context: {} })),
}));

const {
  drainActiveSessionsForShutdown,
  emitGatewaySessionEndPluginHook,
  emitGatewaySessionStartPluginHook,
} = await import("./session-reset-service.js");
const { clearActiveSessionsForShutdownTracker, listActiveSessionsForShutdown } =
  await import("./active-sessions-shutdown-tracker.js");

const cfg: OpenClawConfig = {};

beforeEach(() => {
  clearActiveSessionsForShutdownTracker();
  runSessionEndMock.mockClear();
  hasHooksMock.mockClear();
  hasHooksMock.mockImplementation((name: string) => name === "session_end");
});

afterEach(() => {
  clearActiveSessionsForShutdownTracker();
});

describe("drainActiveSessionsForShutdown", () => {
  it("returns an empty result and skips hook emission when no sessions are tracked", async () => {
    const result = await drainActiveSessionsForShutdown({ reason: "shutdown" });

    expect(result).toEqual({ emittedSessionIds: [], timedOut: false });
    expect(runSessionEndMock).not.toHaveBeenCalled();
  });

  it("fires session_end with reason=shutdown for every tracked session and clears them", async () => {
    emitGatewaySessionStartPluginHook({
      cfg,
      sessionKey: "agent:main:main",
      sessionId: "sess-A",
      storePath: "/tmp/store.json",
    });
    emitGatewaySessionStartPluginHook({
      cfg,
      sessionKey: "agent:main:other",
      sessionId: "sess-B",
      storePath: "/tmp/store.json",
    });

    const result = await drainActiveSessionsForShutdown({ reason: "shutdown" });

    expect(result.timedOut).toBe(false);
    expect(result.emittedSessionIds.sort()).toEqual(["sess-A", "sess-B"]);
    expect(runSessionEndMock).toHaveBeenCalledTimes(2);
    const reasons = runSessionEndMock.mock.calls.map(
      ([event]) => (event as { reason?: string }).reason,
    );
    expect(reasons.every((reason) => reason === "shutdown")).toBe(true);
    // After the drain, the tracker forgets every emitted session (the emit
    // helper calls `forgetActiveSessionForShutdown`), so a second drain is a
    // no-op and we never double-fire on restart loops.
    expect(listActiveSessionsForShutdown()).toEqual([]);
  });

  it("propagates reason=restart when called for a restart shutdown", async () => {
    emitGatewaySessionStartPluginHook({
      cfg,
      sessionKey: "agent:main:main",
      sessionId: "sess-A",
      storePath: "/tmp/store.json",
    });

    await drainActiveSessionsForShutdown({ reason: "restart" });

    expect(runSessionEndMock).toHaveBeenCalledTimes(1);
    expect((runSessionEndMock.mock.calls[0][0] as { reason?: string }).reason).toBe("restart");
  });

  it("does not double-fire for a session already finalized by reset/delete/compaction", async () => {
    emitGatewaySessionStartPluginHook({
      cfg,
      sessionKey: "agent:main:main",
      sessionId: "sess-A",
      storePath: "/tmp/store.json",
    });
    emitGatewaySessionStartPluginHook({
      cfg,
      sessionKey: "agent:main:other",
      sessionId: "sess-B",
      storePath: "/tmp/store.json",
    });
    // Simulate sess-A being finalized through the normal reset path before
    // the gateway is shut down: the matching `session_end` is fired with
    // reason="reset" and the tracker forgets it.
    emitGatewaySessionEndPluginHook({
      cfg,
      sessionKey: "agent:main:main",
      sessionId: "sess-A",
      storePath: "/tmp/store.json",
      reason: "reset",
    });
    runSessionEndMock.mockClear();

    await drainActiveSessionsForShutdown({ reason: "shutdown" });

    expect(runSessionEndMock).toHaveBeenCalledTimes(1);
    expect((runSessionEndMock.mock.calls[0][0] as { sessionId?: string }).sessionId).toBe("sess-B");
  });

  it("still records the session as forgotten when no `session_end` plugins are registered", async () => {
    hasHooksMock.mockImplementation(() => false);
    emitGatewaySessionStartPluginHook({
      cfg,
      sessionKey: "agent:main:main",
      sessionId: "sess-A",
      storePath: "/tmp/store.json",
    });
    // session_end fires while no plugin listens: hook is not run, but the
    // shutdown tracker must still forget the session so the later drain
    // does not pick it up.
    emitGatewaySessionEndPluginHook({
      cfg,
      sessionKey: "agent:main:main",
      sessionId: "sess-A",
      storePath: "/tmp/store.json",
      reason: "deleted",
    });

    expect(listActiveSessionsForShutdown()).toEqual([]);
    const result = await drainActiveSessionsForShutdown({ reason: "shutdown" });

    expect(result.emittedSessionIds).toEqual([]);
  });
});
