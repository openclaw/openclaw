// Regression coverage for the session_end/session_start plugin hook dispatch in
// session-reset-service: both emitters run plugin handlers on a detached work
// continuation, so deferred tracked work (a handler that awaits an untracked
// external promise before trackAsyncWork) survives the triggering request's
// async work scope closing. Sibling of the automatic-reset fix (#146350).
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  getActiveGatewayRootWorkCount,
  resetGatewayWorkAdmission,
  tryBeginGatewayRootWorkAdmission,
} from "../process/gateway-work-admission.js";
import { AsyncWorkScope, trackAsyncWork } from "../shared/async-work-scope.js";
import { createDeferredCore } from "../shared/deferred.js";
import {
  forgetActiveSessionForShutdown,
  listActiveSessionsForShutdown,
} from "./active-sessions-shutdown-tracker.js";

const logs = vi.hoisted(() => ({ verbose: vi.fn() }));

vi.mock("../globals.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../globals.js")>();
  return { ...actual, logVerbose: logs.verbose };
});

const sessionEndHandler = vi.fn(async (_event: unknown) => undefined);
const sessionStartHandler = vi.fn(async (_event: unknown) => undefined);
const hasHooksMock = vi.fn((name: string) => name === "session_end" || name === "session_start");
const getGlobalHookRunnerMock = vi.fn(() => ({
  hasHooks: hasHooksMock,
  runSessionEnd: sessionEndHandler,
  runSessionStart: sessionStartHandler,
}));

vi.mock("../plugins/hook-runner-global.js", () => ({
  getGlobalHookRunner: getGlobalHookRunnerMock,
}));

vi.mock("./session-transcript-files.fs.js", () => ({
  extractGeneratedTranscriptSessionId: vi.fn(() => undefined),
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
  buildSessionStartHookPayload: vi.fn((params: { sessionId: string; sessionKey: string }) => ({
    event: { sessionId: params.sessionId, sessionKey: params.sessionKey },
    context: { sessionId: params.sessionId },
  })),
}));

const { emitGatewaySessionEndPluginHook, emitGatewaySessionStartPluginHook } =
  await import("./session-reset-service.js");

const cfg: OpenClawConfig = {};

async function within<T>(promise: Promise<T>, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(`Timed out waiting for ${label}`)), 2_000);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

function clearTrackedSessions(): void {
  for (const entry of listActiveSessionsForShutdown()) {
    forgetActiveSessionForShutdown(entry.sessionId);
  }
}

beforeEach(() => {
  clearTrackedSessions();
  resetGatewayWorkAdmission();
  sessionEndHandler.mockReset();
  sessionStartHandler.mockReset();
  hasHooksMock.mockReset();
  hasHooksMock.mockImplementation(
    (name: string) => name === "session_end" || name === "session_start",
  );
  logs.verbose.mockReset();
});

afterEach(() => {
  clearTrackedSessions();
  resetGatewayWorkAdmission();
});

describe("session lifecycle plugin hook lifetime", () => {
  async function exerciseSessionEnd(options: { parent: boolean; throws?: boolean }) {
    const parent = options.parent ? new AsyncWorkScope() : undefined;
    const root = options.parent ? tryBeginGatewayRootWorkAdmission("test:session-end") : undefined;
    const entered = createDeferredCore();
    const release = createDeferredCore();
    const finished = createDeferredCore();
    const effect = vi.fn();
    sessionEndHandler.mockImplementation(async () => {
      entered.resolve();
      try {
        await release.promise;
        await trackAsyncWork(() => {
          effect();
          if (options.throws) {
            throw new Error("synthetic session cleanup failure");
          }
        });
      } finally {
        finished.resolve();
      }
    });

    const emit = () =>
      emitGatewaySessionEndPluginHook({
        cfg,
        sessionKey: "agent:main:main",
        sessionId: "sess-A",
        storePath: "/tmp/store.json",
        agentId: "main",
        reason: "reset",
      });

    try {
      if (parent) {
        if (!root) {
          throw new Error("Expected parent root admission");
        }
        await root.run(async () => parent.run(emit));
      } else {
        emit();
      }
      await within(entered.promise, "hook entry");
      root?.release();
      if (parent) {
        // The barrier deliberately keeps the hook pending until its requester
        // has fully drained. No elapsed-time race decides the ordering.
        await within(parent.drain(), "requester closure");
        expect(parent.isClosing).toBe(true);
      }
      expect(effect).not.toHaveBeenCalled();
      // The detached continuation's reserved root keeps the process drain
      // waiting for the deferred work even after the requester closed.
      expect(getActiveGatewayRootWorkCount()).toBe(1);
      release.resolve();
      await within(finished.promise, "delayed hook completion");
      expect(effect).toHaveBeenCalledExactlyOnceWith();
      await vi.waitFor(() => expect(getActiveGatewayRootWorkCount()).toBe(0), {
        timeout: 2_000,
        interval: 10,
      });
      if (options.throws) {
        expect(logs.verbose).toHaveBeenCalledExactlyOnceWith(
          "session_end hook failed: Error: synthetic session cleanup failure",
        );
      } else {
        expect(logs.verbose).not.toHaveBeenCalled();
      }
    } finally {
      release.resolve();
      root?.release();
      try {
        await within(finished.promise, "hook cleanup");
        if (parent) {
          await within(parent.drain(), "requester cleanup");
        }
        await vi.waitFor(() => expect(getActiveGatewayRootWorkCount()).toBe(0), {
          timeout: 2_000,
          interval: 10,
        });
      } catch {
        // The exercise assertions already reported the meaningful failure.
      }
    }
  }

  it("session_end completes delayed tracked work after the triggering requester closes", async () => {
    await exerciseSessionEnd({ parent: true });
  });

  it("session_end owns and releases delayed hook work when there is no parent request", async () => {
    await exerciseSessionEnd({ parent: false });
  });

  it("session_end releases work and logs when a delayed hook throws", async () => {
    await exerciseSessionEnd({ parent: true, throws: true });
  });

  it("session_start completes delayed tracked work after the triggering requester closes", async () => {
    const parent = new AsyncWorkScope();
    const root = tryBeginGatewayRootWorkAdmission("test:session-start");
    expect(root).not.toBeNull();
    const entered = createDeferredCore();
    const release = createDeferredCore();
    const finished = createDeferredCore();
    const effect = vi.fn();
    sessionStartHandler.mockImplementation(async () => {
      entered.resolve();
      try {
        await release.promise;
        await trackAsyncWork(effect);
      } finally {
        finished.resolve();
      }
    });

    try {
      await root!.run(async () =>
        parent.run(() => {
          emitGatewaySessionStartPluginHook({
            cfg,
            sessionKey: "agent:main:main",
            sessionId: "sess-B",
            storePath: "/tmp/store.json",
            agentId: "main",
          });
        }),
      );
      await within(entered.promise, "hook entry");
      root!.release();
      await within(parent.drain(), "requester closure");
      expect(parent.isClosing).toBe(true);
      expect(effect).not.toHaveBeenCalled();
      expect(getActiveGatewayRootWorkCount()).toBe(1);
      release.resolve();
      await within(finished.promise, "delayed hook completion");
      expect(effect).toHaveBeenCalledExactlyOnceWith();
      await vi.waitFor(() => expect(getActiveGatewayRootWorkCount()).toBe(0), {
        timeout: 2_000,
        interval: 10,
      });
      expect(logs.verbose).not.toHaveBeenCalled();
    } finally {
      release.resolve();
      root!.release();
      try {
        await within(finished.promise, "hook cleanup");
        await within(parent.drain(), "requester cleanup");
        await vi.waitFor(() => expect(getActiveGatewayRootWorkCount()).toBe(0), {
          timeout: 2_000,
          interval: 10,
        });
      } catch {
        // The exercise assertions already reported the meaningful failure.
      }
    }
  });
});
