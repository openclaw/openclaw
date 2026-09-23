import { afterEach, describe, expect, it, vi } from "vitest";
import type { PluginRuntime } from "../plugins/runtime/types.js";
import type { RealtimeVoiceProviderPlugin } from "../plugins/types.js";
import { createDeferredCore } from "../shared/deferred.js";
import {
  closeOpenClawStateDatabaseAsync,
  closeOpenClawStateDatabaseForTest,
} from "../state/openclaw-state-db.js";
import type { RealtimeVoiceBridge } from "../talk/provider-types.js";
import { startMeetingRealtimeEngine } from "./realtime-engine.js";
import { createTestRuntime, type TestSession } from "./session-runtime.test-support.js";

afterEach(async () => {
  await closeOpenClawStateDatabaseAsync();
  closeOpenClawStateDatabaseForTest();
});

describe("MeetingSessionRuntime startup custody", () => {
  async function createStartupFixture(options: { failConnect?: boolean } = {}) {
    const connectStarted = createDeferredCore();
    const connectAllowed = createDeferredCore();
    const liveProviders = new Set<string>();
    const liveInputs = new Set<string>();
    const closedProviders: string[] = [];
    const createdProviders: string[] = [];
    const spoken: string[] = [];
    let firstSessionId: string | undefined;
    const { runtime } = createTestRuntime({
      talkBack: true,
      joinTransport: async ({ session }) => {
        firstSessionId ??= session.id;
        session.browser = {
          launched: true,
          tab: { targetId: session.url, openedByPlugin: true },
          health: { inCall: true, micMuted: false },
        };
        return {};
      },
      releaseBrowserTab: async (session) => {
        if (session.browser) {
          session.browser.tab = undefined;
        }
        return true;
      },
      ensureRealtimeBridge: async (session) => {
        if (session.browser?.hasAudioBridge) {
          return undefined;
        }
        const bridge: RealtimeVoiceBridge = {
          acknowledgeMark: () => {},
          close: () => {
            closedProviders.push(session.id);
            liveProviders.delete(session.id);
            if (session.id === firstSessionId) {
              connectAllowed.resolve();
            }
          },
          connect: async () => {
            if (session.id === firstSessionId) {
              connectStarted.resolve();
              await connectAllowed.promise;
              if (options.failConnect) {
                throw new Error("synthetic connect failure");
              }
            }
          },
          handleBargeIn: () => {},
          isConnected: () => liveProviders.has(session.id),
          sendAudio: () => {},
          sendUserMessage: () => {
            spoken.push(session.id);
          },
          setMediaTimestamp: () => {},
          submitToolResult: () => {},
        };
        const provider: RealtimeVoiceProviderPlugin = {
          id: "startup-custody-test",
          label: "Startup custody test",
          isConfigured: () => true,
          createBridge: () => {
            liveProviders.add(session.id);
            createdProviders.push(session.id);
            return bridge;
          },
        };
        const handle = await startMeetingRealtimeEngine({
          config: {
            chrome: { audioFormat: "pcm16-24khz" },
            realtime: {
              strategy: "bidi",
              provider: provider.id,
              providers: { [provider.id]: {} },
            },
          },
          fullConfig: {},
          runtime: {} as PluginRuntime,
          platform: {
            displayName: "Test meeting",
            logScope: "[test-meeting]",
            sessionIdPrefix: "test-meeting",
          },
          meetingSessionId: session.id,
          logger: { debug: vi.fn(), error: vi.fn(), info: vi.fn(), warn: vi.fn() },
          providers: [provider],
          consultAgent: async () => ({ text: "unused" }),
          tools: [],
          handleToolCall: async () => {},
          transport: {
            onFatal: () => {},
            startInput: () => {
              liveInputs.add(session.id);
            },
            stop: async () => {
              liveInputs.delete(session.id);
            },
            dispose: async () => {
              liveInputs.delete(session.id);
            },
            writeOutput: async () => {},
            clearOutput: async () => {},
          },
        });
        if (session.browser) {
          session.browser.hasAudioBridge = true;
        }
        return handle;
      },
    });
    const { session } = await runtime.join({
      url: "https://meeting.example/held",
      agentId: "main",
    });
    return {
      runtime,
      session,
      connectStarted,
      connectAllowed,
      liveProviders,
      liveInputs,
      closedProviders,
      createdProviders,
      spoken,
    };
  }

  async function completeUnrelatedMeeting(
    runtime: Awaited<ReturnType<typeof createStartupFixture>>["runtime"],
  ) {
    const { session } = await runtime.join({
      url: "https://meeting.example/progress",
      agentId: "other",
    });
    await runtime.leave(session.id);
  }

  it("settles a connecting provider before reporting leave completion", async () => {
    const f = await createStartupFixture();
    const speaking = f.runtime.speak(f.session.id, "Hello");
    let leaving: Promise<unknown> | undefined;
    let liveAtLeave: boolean | undefined;
    try {
      await f.connectStarted.promise;
      expect(f.liveProviders.has(f.session.id)).toBe(true);
      expect(f.liveInputs.has(f.session.id)).toBe(true);
      leaving = f.runtime.leave(f.session.id).then((result) => {
        liveAtLeave = f.liveProviders.has(f.session.id) || f.liveInputs.has(f.session.id);
        return result;
      });
      // Independent public work advances while this provider's connect is held.
      // A correct owner may close it now or wait for connect before settling leave.
      await completeUnrelatedMeeting(f.runtime);
      f.connectAllowed.resolve();
      await Promise.all([leaving, speaking]);
      expect(liveAtLeave).toBe(false);
    } finally {
      f.connectAllowed.resolve();
      await Promise.all([speaking, leaving]);
      await f.runtime.leave(f.session.id);
    }
  });

  it("settles prior connecting work before admitting a same-URL replacement", async () => {
    const f = await createStartupFixture();
    const speaking = f.runtime.speak(f.session.id, "Hello");
    let replacement: TestSession | undefined;
    let replacing: Promise<void> | undefined;
    let priorLiveAtReplacement: boolean | undefined;
    try {
      await f.connectStarted.promise;
      replacing = (async () => {
        await f.runtime.leave(f.session.id);
        replacement = (await f.runtime.join({ url: f.session.url, agentId: "replacement" }))
          .session;
        priorLiveAtReplacement = f.liveProviders.has(f.session.id);
        await f.runtime.speak(replacement.id, "Replacement");
        expect(f.liveProviders.has(replacement.id)).toBe(true);
      })();
      await completeUnrelatedMeeting(f.runtime);
      f.connectAllowed.resolve();
      await Promise.all([replacing, speaking]);
      expect(priorLiveAtReplacement).toBe(false);
    } finally {
      f.connectAllowed.resolve();
      await Promise.all([speaking, replacing]);
      await f.runtime.leave(f.session.id);
      if (replacement) {
        await f.runtime.leave(replacement.id);
      }
    }
  });

  it("keeps unrelated-URL work independent of a connecting provider", async () => {
    const f = await createStartupFixture();
    const speaking = f.runtime.speak(f.session.id, "Hello");
    let other: TestSession | undefined;
    try {
      await f.connectStarted.promise;
      other = (await f.runtime.join({ url: "https://meeting.example/other", agentId: "main" }))
        .session;
      await f.runtime.speak(other.id, "Other meeting");
      await f.runtime.leave(other.id);
      expect(f.liveProviders.has(f.session.id)).toBe(true);
      expect(f.liveProviders.has(other.id)).toBe(false);
    } finally {
      f.connectAllowed.resolve();
      await speaking;
      await f.runtime.leave(f.session.id);
      if (other) {
        await f.runtime.leave(other.id);
      }
    }
  });

  it("stops late successful startup once without publishing speech", async () => {
    const f = await createStartupFixture();
    const speaking = f.runtime.speak(f.session.id, "Hello");
    try {
      await f.connectStarted.promise;
      const leaving = f.runtime.leave(f.session.id);
      await completeUnrelatedMeeting(f.runtime);
      f.connectAllowed.resolve();
      await leaving;
      await expect(speaking).resolves.toMatchObject({ found: true, spoken: false });
      expect(f.liveProviders.size).toBe(0);
      expect(f.liveInputs.size).toBe(0);
      expect(f.closedProviders).toEqual([f.session.id]);
      expect(f.spoken).toEqual([]);
      await f.runtime.leave(f.session.id);
      expect(f.closedProviders).toEqual([f.session.id]);
    } finally {
      f.connectAllowed.resolve();
      await speaking;
      await f.runtime.leave(f.session.id);
    }
  });

  it("closes a normally connected provider once on leave", async () => {
    const f = await createStartupFixture();
    f.connectAllowed.resolve();
    try {
      await f.runtime.speak(f.session.id, "Hello");
      expect(f.liveProviders.has(f.session.id)).toBe(true);
      await f.runtime.leave(f.session.id);
      await f.runtime.leave(f.session.id);
      expect(f.liveProviders.size).toBe(0);
      expect(f.liveInputs.size).toBe(0);
      expect(f.closedProviders).toEqual([f.session.id]);
    } finally {
      await f.runtime.leave(f.session.id);
    }
  });
  it("coalesces simultaneous speaks before invoking provider setup", async () => {
    const f = await createStartupFixture();
    const first = f.runtime.speak(f.session.id, "First");
    const second = f.runtime.speak(f.session.id, "Second");
    try {
      await f.connectStarted.promise;
      await completeUnrelatedMeeting(f.runtime);
      f.connectAllowed.resolve();
      await Promise.all([first, second]);
      expect(f.createdProviders).toEqual([f.session.id]);
    } finally {
      f.connectAllowed.resolve();
      await Promise.all([first, second]);
      await f.runtime.leave(f.session.id);
    }
  });

  it("retains pending startup after an external end marker", async () => {
    const f = await createStartupFixture();
    const speaking = f.runtime.speak(f.session.id, "Hello");
    let leaving: Promise<unknown> | undefined;
    let liveAtLeave: boolean | undefined;
    try {
      await f.connectStarted.promise;
      f.runtime.markSessionEnded(f.session, "External session ended");
      leaving = f.runtime.leave(f.session.id).then((result) => {
        liveAtLeave = f.liveProviders.has(f.session.id);
        return result;
      });
      await completeUnrelatedMeeting(f.runtime);
      f.connectAllowed.resolve();
      await Promise.all([speaking, leaving]);
      expect(liveAtLeave).toBe(false);
      expect(f.closedProviders).toEqual([f.session.id]);
    } finally {
      f.connectAllowed.resolve();
      await Promise.all([speaking, leaving]);
      await f.runtime.leave(f.session.id);
    }
  });

  it("joins rejected startup cleanup while preserving its original failure", async () => {
    const f = await createStartupFixture({ failConnect: true });
    const speaking = f.runtime.speak(f.session.id, "Hello");
    const rejected = expect(speaking).rejects.toThrow("synthetic connect failure");
    let leaving: Promise<unknown> | undefined;
    try {
      await f.connectStarted.promise;
      leaving = f.runtime.leave(f.session.id);
      f.connectAllowed.resolve();
      await Promise.all([rejected, leaving]);
      expect(f.liveProviders.size).toBe(0);
      expect(f.liveInputs.size).toBe(0);
      expect(f.closedProviders).toEqual([f.session.id]);
    } finally {
      f.connectAllowed.resolve();
      await Promise.all([rejected, leaving]);
      await f.runtime.leave(f.session.id);
    }
  });
});
