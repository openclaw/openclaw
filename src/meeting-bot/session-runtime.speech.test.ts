import { afterEach, describe, expect, it, vi } from "vitest";
import { createDeferredCore } from "../shared/deferred.js";
import {
  closeOpenClawStateDatabaseAsync,
  closeOpenClawStateDatabaseForTest,
} from "../state/openclaw-state-db.js";
import type { MeetingSessionRuntimeHandles } from "./session-runtime.js";
import { createTestRuntime } from "./session-runtime.test-support.js";
import type { MeetingBrowserHealth } from "./session-types.js";

type SpeechHandle = NonNullable<MeetingSessionRuntimeHandles<MeetingBrowserHealth>["speak"]>;

function createReadySpeechRuntime(
  speak: SpeechHandle,
  refreshBrowserHealth?: Parameters<typeof createTestRuntime>[0]["refreshBrowserHealth"],
) {
  return createTestRuntime({
    talkBack: true,
    releaseBrowserTab: async () => true,
    refreshBrowserHealth,
    joinTransport: async ({ session, context }) => {
      session.browser = {
        launched: true,
        hasAudioBridge: true,
        health: { inCall: true, micMuted: false },
      };
      context.attachRuntimeHandles(session, { speak });
      return {};
    },
  });
}

afterEach(async () => {
  await closeOpenClawStateDatabaseAsync();
  closeOpenClawStateDatabaseForTest();
});

describe("MeetingSessionRuntime speech readiness", () => {
  it("rejects speech when its source expires during browser readiness", async () => {
    const readinessStarted = createDeferredCore();
    const readinessFinished = createDeferredCore();
    const expired = new Error("Speech source expired");
    let sourceCurrent = true;
    const speak = vi.fn();
    const ensureRealtimeBridge = vi.fn(async () => undefined);
    const { runtime } = createTestRuntime({
      talkBack: true,
      releaseBrowserTab: async () => true,
      ensureRealtimeBridge,
      refreshBrowserHealth: async (session) => {
        readinessStarted.resolve();
        await readinessFinished.promise;
        session.browser!.health = { inCall: true, micMuted: false };
      },
      joinTransport: async ({ session, context }) => {
        session.browser = {
          launched: true,
          hasAudioBridge: true,
          health: { inCall: true },
        };
        context.attachRuntimeHandles(session, { speak });
        return {};
      },
    });
    const { session } = await runtime.join({
      url: "https://meeting.example/room",
      agentId: "main",
    });

    const pendingSpeech = runtime.speak(session.id, "Answer the current question", () => {
      if (!sourceCurrent) {
        throw expired;
      }
    });
    await readinessStarted.promise;
    sourceCurrent = false;
    readinessFinished.resolve();

    await expect(pendingSpeech).rejects.toBe(expired);
    expect(ensureRealtimeBridge).not.toHaveBeenCalled();
    expect(speak).not.toHaveBeenCalled();
  });

  it("keeps a recovered bridge owned for cleanup when its speech source expires", async () => {
    const recoveryStarted = createDeferredCore();
    const recoveryFinished = createDeferredCore();
    const expired = new Error("Speech source expired");
    let sourceCurrent = true;
    const speak = vi.fn();
    const stop = vi.fn(async () => {});
    const { runtime } = createTestRuntime({
      talkBack: true,
      releaseBrowserTab: async () => true,
      ensureRealtimeBridge: async (session) => {
        recoveryStarted.resolve();
        await recoveryFinished.promise;
        session.browser!.hasAudioBridge = true;
        return { speak, stop };
      },
      joinTransport: async ({ session }) => {
        session.browser = {
          launched: true,
          hasAudioBridge: false,
          health: { inCall: true, micMuted: false },
        };
        return {};
      },
    });
    const { session } = await runtime.join({
      url: "https://meeting.example/room",
      agentId: "main",
    });

    const pendingSpeech = runtime.speak(session.id, "Answer the current question", () => {
      if (!sourceCurrent) {
        throw expired;
      }
    });
    await recoveryStarted.promise;
    sourceCurrent = false;
    recoveryFinished.resolve();

    await expect(pendingSpeech).rejects.toBe(expired);
    expect(speak).not.toHaveBeenCalled();
    expect(stop).not.toHaveBeenCalled();
    await expect(runtime.leave(session.id)).resolves.toMatchObject({
      found: true,
      session: { state: "ended" },
    });
    expect(stop).toHaveBeenCalledOnce();
  });

  it.each(["source expiry", "session leave"] as const)(
    "forwards a live speech guard that rejects after %s",
    async (invalidation) => {
      let sourceCurrent = true;
      const speak = vi.fn<SpeechHandle>();
      const { runtime } = createReadySpeechRuntime(speak);
      const { session } = await runtime.join({
        url: "https://meeting.example/room",
        agentId: "main",
      });

      await expect(
        runtime.speak(session.id, "Answer the current question", () => {
          if (!sourceCurrent) {
            throw new Error("Speech source expired");
          }
        }),
      ).resolves.toMatchObject({ found: true, spoken: true });
      expect(speak).toHaveBeenCalledExactlyOnceWith(
        "Answer the current question",
        expect.any(Function),
        undefined,
      );
      const forwardedGuard = speak.mock.calls[0]?.[1];
      expect(forwardedGuard).not.toThrow();

      if (invalidation === "session leave") {
        await runtime.leave(session.id);
      } else {
        sourceCurrent = false;
      }
      expect(forwardedGuard).toThrow(
        invalidation === "session leave"
          ? "Meeting session is no longer active"
          : "Speech source expired",
      );
    },
  );

  it("forwards source refresh and rejects when asynchronous speech submission fails", async () => {
    const submissionStarted = createDeferredCore();
    const sourceRefresh = createDeferredCore();
    const refreshFailed = new Error("Speech source refresh failed");
    const refreshCurrent = vi.fn(() => sourceRefresh.promise);
    const speak = vi.fn<SpeechHandle>(async (_instructions, assertCurrent, refreshSource) => {
      assertCurrent?.();
      submissionStarted.resolve();
      await refreshSource?.();
    });
    const { runtime } = createReadySpeechRuntime(speak);
    const { session } = await runtime.join({
      url: "https://meeting.example/room",
      agentId: "main",
    });

    const pendingSpeech = runtime.speak(
      session.id,
      "Answer the current question",
      undefined,
      refreshCurrent,
    );
    await submissionStarted.promise;
    expect(speak).toHaveBeenCalledExactlyOnceWith(
      "Answer the current question",
      expect.any(Function),
      expect.any(Function),
    );
    expect(refreshCurrent).toHaveBeenCalledOnce();
    sourceRefresh.reject(refreshFailed);

    await expect(pendingSpeech).rejects.toBe(refreshFailed);
  });

  it.each(["synthesis", "source refresh"] as const)(
    "rejects the final speech guard when the microphone mutes during delayed %s",
    async (phase) => {
      const started = createDeferredCore();
      const finished = createDeferredCore();
      const written: string[] = [];
      const delay = async () => {
        started.resolve();
        await finished.promise;
      };
      const refreshCurrent = vi.fn(async () => {
        if (phase === "source refresh") {
          await delay();
        }
      });
      const speak = vi.fn<SpeechHandle>(async (text, assertCurrent, refreshSource) => {
        if (phase === "synthesis") {
          await delay();
        }
        assertCurrent?.();
        await refreshSource?.();
        assertCurrent?.();
        if (text) {
          written.push(text);
        }
      });
      const { runtime } = createReadySpeechRuntime(speak);
      const { session } = await runtime.join({
        url: "https://meeting.example/room",
        agentId: "main",
      });

      const pendingSpeech = runtime.speak(session.id, "Current answer", undefined, refreshCurrent);
      await started.promise;
      expect(session.browser?.health?.speechReady).toBe(true);
      session.browser!.health!.micMuted = true;
      finished.resolve();

      await expect(pendingSpeech).rejects.toThrow("Realtime speech blocked: microphone muted");
      expect(written).toEqual([]);
      expect(session.browser?.health).toMatchObject({
        speechReady: false,
        speechBlockedReason: "microphone-muted",
      });
    },
  );

  it("keeps manual speech unguarded by refresh and rechecks source-backed audio read-only", async () => {
    const order: string[] = [];
    const speak = vi.fn<SpeechHandle>(async (_text, assertCurrent, refreshCurrent) => {
      await refreshCurrent?.();
      assertCurrent?.();
      order.push("write");
    });
    const refreshBrowserHealth = vi.fn(async () => {
      order.push("browser");
    });
    const { runtime } = createReadySpeechRuntime(speak, refreshBrowserHealth);
    const { session } = await runtime.join({
      url: "https://meeting.example/room",
      agentId: "main",
    });

    await expect(runtime.speak(session.id, "Manual greeting")).resolves.toMatchObject({
      spoken: true,
    });
    expect(speak).toHaveBeenCalledExactlyOnceWith(
      "Manual greeting",
      expect.any(Function),
      undefined,
    );
    expect(refreshBrowserHealth).not.toHaveBeenCalled();

    const refreshCurrent = vi.fn(async () => {
      order.push("source");
    });
    await expect(
      runtime.speak(session.id, "Current answer", undefined, refreshCurrent),
    ).resolves.toMatchObject({ spoken: true });
    expect(refreshCurrent).toHaveBeenCalledOnce();
    expect(refreshBrowserHealth).toHaveBeenCalledExactlyOnceWith(session, {
      force: true,
      readOnly: true,
    });
    expect(order).toEqual(["write", "source", "browser", "write"]);
  });

  it("treats an unknown microphone state as transiently unverified", async () => {
    const { runtime } = createTestRuntime({
      talkBack: true,
      releaseBrowserTab: async () => true,
      joinTransport: async ({ session }) => {
        session.browser = {
          launched: true,
          hasAudioBridge: true,
          health: { inCall: true },
        };
        return {};
      },
    });
    const { session } = await runtime.join({
      url: "https://meeting.example/room",
      agentId: "main",
    });

    expect(runtime.refreshSpeechReadiness(session)).toEqual({
      ready: false,
      reason: "browser-unverified",
      message: "browser unverified",
    });
    expect(session.browser?.health).toMatchObject({
      speechReady: false,
      speechBlockedReason: "browser-unverified",
    });

    session.browser!.health = { ...session.browser?.health, micMuted: false };
    expect(runtime.refreshSpeechReadiness(session)).toEqual({ ready: true });
  });
});
