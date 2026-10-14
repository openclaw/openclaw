import { afterEach, describe, expect, it, vi } from "vitest";
import type { PluginRuntime } from "../plugins/runtime/types.js";
import type { RealtimeVoiceProviderPlugin } from "../plugins/types.js";
import { createDeferredCore } from "../shared/deferred.js";
import {
  closeOpenClawStateDatabaseAsync,
  closeOpenClawStateDatabaseForTest,
} from "../state/openclaw-state-db.js";
import type { RealtimeVoiceBridge } from "../talk/provider-types.js";
import {
  TEST_CAPTION_SOURCE,
  TEST_MEETING_URL,
  testMeetingObservation,
} from "./observation-provenance.test-support.js";
import { startMeetingRealtimeEngine } from "./realtime-engine.js";
import {
  createParticipationTestRuntime,
  createTestRuntime,
  type TestSession,
} from "./session-runtime.test-support.js";
import type { MeetingTranscriptSnapshot } from "./session-types.js";

afterEach(() => {
  vi.useRealTimers();
});

describe("MeetingSessionRuntime startup custody", () => {
  afterEach(async () => {
    await closeOpenClawStateDatabaseAsync();
    closeOpenClawStateDatabaseForTest();
  });
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

  it.each(["leave", "external end", "connect failure"] as const)(
    "settles pending startup once without publishing speech after %s",
    async (outcome) => {
      const f = await createStartupFixture({ failConnect: outcome === "connect failure" });
      const speaking = f.runtime.speak(f.session.id, "Hello");
      const settled =
        outcome === "connect failure"
          ? expect(speaking).rejects.toThrow("synthetic connect failure")
          : expect(speaking).resolves.toMatchObject({ found: true, spoken: false });
      let leaving: Promise<unknown> | undefined;
      let liveAtLeave: boolean | undefined;
      try {
        await f.connectStarted.promise;
        expect(f.liveProviders.has(f.session.id)).toBe(true);
        expect(f.liveInputs.has(f.session.id)).toBe(true);
        if (outcome === "external end") {
          f.runtime.markSessionEnded(f.session, "External session ended");
        }
        leaving = f.runtime.leave(f.session.id).then((result) => {
          liveAtLeave = f.liveProviders.has(f.session.id) || f.liveInputs.has(f.session.id);
          return result;
        });
        await completeUnrelatedMeeting(f.runtime);
        f.connectAllowed.resolve();
        await Promise.all([leaving, settled]);
        expect(liveAtLeave).toBe(false);
        expect(f.liveProviders.size).toBe(0);
        expect(f.liveInputs.size).toBe(0);
        expect(f.closedProviders).toEqual([f.session.id]);
        expect(f.spoken).toEqual([]);
        await f.runtime.leave(f.session.id);
        expect(f.closedProviders).toEqual([f.session.id]);
      } finally {
        f.connectAllowed.resolve();
        await Promise.all([settled, leaving]);
        await f.runtime.leave(f.session.id);
      }
    },
  );

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
});

describe("MeetingSessionRuntime participation ownership", () => {
  it("revokes participation as soon as leave starts, while an admitted claim is awaiting storage", async () => {
    const { runtime, store, execute } = createParticipationTestRuntime();
    const { session } = await runtime.join({
      url: "https://meeting.example/room",
      agentId: "operator",
    });
    const { promise: pending, resolve: release } = createDeferredCore();
    const { promise: entered, resolve: claimed } = createDeferredCore();
    const register = store.registerIfAbsent;
    store.registerIfAbsent = async (...args) => {
      claimed();
      await pending;
      return await register(...args);
    };
    const action = runtime.participate(session.id, {
      requestId: "raise",
      action: { type: "hand.set", raised: true },
    });
    await entered;
    const leaving = runtime.leave(session.id);
    expect(runtime.participationContext(session.id)).toMatchObject({
      active: false,
      capabilities: [],
    });
    release();
    expect(await action).toMatchObject({ status: "rejected" });
    await leaving;
    expect(execute).not.toHaveBeenCalled();
  });

  it("does not transfer an observed source to a replacement browser tab", async () => {
    const { runtime, execute } = createParticipationTestRuntime();
    const { session } = await runtime.join({
      url: "https://meeting.example/room",
      agentId: "operator",
    });
    const sourceId = runtime.observeParticipationSource(session.id, {
      id: "message",
      epoch: "page",
      revision: "1",
      kind: "chat",
      text: "Raise your hand",
      finalized: true,
    });
    expect(sourceId).toBeTruthy();
    session.browser!.tab = { targetId: "replacement-tab", openedByPlugin: false };
    expect(runtime.inspectParticipationSource(session.id, sourceId!)).toBeUndefined();
    expect(
      await runtime.participate(session.id, {
        requestId: "raise",
        sourceId,
        action: { type: "hand.set", raised: true },
      }),
    ).toMatchObject({ status: "rejected" });
    expect(execute).not.toHaveBeenCalled();
    await runtime.leave(session.id);
  });

  it.each([
    { participation: true, change: "tab" },
    ...["tab", "id", "url", "state", "transport", "node"].map((change) => ({
      participation: false,
      change,
    })),
  ])(
    "revalidates $change during caption capture (participation: $participation)",
    async ({ participation, change }) => {
      const pending = createDeferredCore<MeetingTranscriptSnapshot>();
      const entered = createDeferredCore();
      const captureTranscript = vi
        .fn<NonNullable<Parameters<typeof createTestRuntime>[0]["captureTranscript"]>>()
        .mockImplementationOnce(async () => {
          entered.resolve();
          return await pending.promise;
        })
        .mockImplementation(async () => (participation ? undefined : await pending.promise));
      const { runtime } = participation
        ? createParticipationTestRuntime({ captureTranscript, transcribe: true })
        : createTestRuntime({
            transcribe: true,
            captureTranscript,
            joinTransport: async ({ session }) => {
              session.browser = {
                launched: true,
                tab: { targetId: "original-tab", openedByPlugin: false },
              };
              return {};
            },
            releaseBrowserTab: async () => true,
          });
      const url = "https://meeting.example/room";
      const { session } = await runtime.join({ url, agentId: "operator" });
      const sessionId = session.id;
      const reading = runtime.transcript(sessionId);
      await entered.promise;
      session.browser!.tab!.targetId = "recovered-tab";
      session.id = change === "id" ? "another-session" : session.id;
      session.url = change === "url" ? `${url}/other` : url;
      session.state = change === "state" ? "ended" : session.state;
      session.transport = change === "transport" ? "chrome-node" : session.transport;
      session.browser!.nodeId = change === "node" ? "another-node" : undefined;
      pending.resolve({
        droppedLines: 0,
        epoch: "old-page",
        lines: [
          {
            text: "Recovered caption",
            ...(participation
              ? {
                  source: {
                    id: "old-caption",
                    epoch: "old-page",
                    revision: "2",
                    finalized: true,
                    ownEcho: false,
                  },
                }
              : {}),
          },
        ],
      });
      if (!participation && change === "tab") {
        await expect(reading).resolves.toMatchObject({ lines: [{ text: "Recovered caption" }] });
      } else {
        await expect(reading).rejects.toThrow("no longer owns the captured browser tab and route");
      }
      if (participation) {
        expect(runtime.participationContext(sessionId)).toMatchObject({
          sourceOrder: 0,
          sources: [],
        });
      }
      session.id = sessionId;
      await runtime.leave(sessionId);
    },
  );

  it("records a caption's original order before finalization and revokes it on a pending correction", async () => {
    const source = {
      id: "caption-1",
      epoch: "page-1",
      revision: "1",
      finalized: false,
      ownEcho: false,
    };
    const completed = {
      text: "Please share the recap",
      source: { ...source, revision: "2", finalized: true },
    };
    const snapshots: MeetingTranscriptSnapshot[] = [
      {
        droppedLines: 0,
        epoch: "page-1",
        lines: [],
        pendingLines: [{ text: "Please share", source }],
      },
      { droppedLines: 0, epoch: "page-1", lines: [completed], pendingLines: [] },
      {
        droppedLines: 0,
        epoch: "page-1",
        lines: [completed],
        pendingLines: [{ text: "Please wait", source: { ...source, revision: "3" } }],
      },
    ];
    const { runtime } = createParticipationTestRuntime({
      captureTranscript: async () => snapshots.shift(),
      transcribe: true,
    });
    const { session } = await runtime.join({
      url: "https://meeting.example/room",
      agentId: "operator",
    });
    await runtime.transcript(session.id);
    expect(runtime.participationContext(session.id)).toMatchObject({ sourceOrder: 1, sources: [] });
    await runtime.transcript(session.id);
    const context = runtime.participationContext(session.id);
    expect(context).toMatchObject({
      sourceOrder: 1,
      sources: [{ id: "caption-1", kind: "caption", order: 1, finalized: true, ownEcho: false }],
    });
    const sourceId = context.sources[0]?.sourceId;
    expect(sourceId).toBeTruthy();
    await runtime.transcript(session.id);
    expect(runtime.participationContext(session.id)).toMatchObject({ sourceOrder: 1, sources: [] });
    expect(runtime.inspectParticipationSource(session.id, sourceId!)).toBeUndefined();
    await runtime.leave(session.id);
  });

  it("invalidates caption authority on an empty new epoch without minting a source event", async () => {
    const oldSnapshot: MeetingTranscriptSnapshot = {
      droppedLines: 0,
      epoch: "old-page",
      lines: [
        {
          text: "Please share the recap",
          source: {
            id: "caption-1",
            epoch: "old-page",
            revision: "2",
            finalized: true,
            ownEcho: false,
          },
        },
      ],
    };
    const snapshots: MeetingTranscriptSnapshot[] = [
      oldSnapshot,
      { droppedLines: 0, epoch: "new-page", lines: [], pendingLines: [] },
      oldSnapshot,
    ];
    const { runtime } = createParticipationTestRuntime({
      captureTranscript: async () => snapshots.shift(),
      transcribe: true,
    });
    const { session } = await runtime.join({
      url: "https://meeting.example/room",
      agentId: "operator",
    });
    await runtime.transcript(session.id);
    const sourceId = runtime.participationContext(session.id).sources[0]?.sourceId;
    expect(sourceId).toBeTruthy();
    await runtime.transcript(session.id);
    expect(runtime.inspectParticipationSource(session.id, sourceId!)).toBeUndefined();
    expect(runtime.participationContext(session.id)).toMatchObject({ sourceOrder: 1, sources: [] });
    await runtime.transcript(session.id);
    expect(runtime.participationContext(session.id)).toMatchObject({ sourceOrder: 1, sources: [] });
    await runtime.leave(session.id);
  });
});

describe("MeetingSessionRuntime observation provenance", () => {
  it("isolates retained row, input, context, and inspect envelopes without renewing unchanged sources", async () => {
    vi.useFakeTimers();
    const firstObservedAt = Date.parse("2026-09-01T00:00:00.000Z");
    vi.setSystemTime(firstObservedAt);
    const provenance = testMeetingObservation();
    const expected = { ...provenance };
    let snapshot: MeetingTranscriptSnapshot = {
      droppedLines: 0,
      epoch: "epoch-1",
      lines: [
        { text: "An invitation", source: { ...TEST_CAPTION_SOURCE }, provenance },
        { text: "Another retained row", provenance },
      ],
    };
    const { runtime } = createParticipationTestRuntime({
      transcribe: true,
      captureTranscript: async () => snapshot,
    });
    const { session } = await runtime.join({ url: TEST_MEETING_URL, agentId: "operator" });
    try {
      const transcript = await runtime.transcript(session.id);
      const context = runtime.participationContext(session.id);
      const sourceId = context.sources[0]!.sourceId;
      const inspected = runtime.inspectParticipationSource(session.id, sourceId);
      expect(inspected).toBeDefined();
      expect(transcript.lines?.map((line) => line.provenance)).toEqual([expected, expected]);

      provenance.speaker = "Changed input";
      transcript.lines![0]!.provenance!.speaker = "Changed returned row";
      context.sources[0]!.provenance!.speaker = "Changed returned context";
      inspected!.source.provenance!.speaker = "Changed returned inspection";
      expect(transcript.lines?.[1]?.provenance).toEqual(expected);
      expect(runtime.participationContext(session.id).sources[0]?.provenance).toEqual(expected);
      expect(runtime.inspectParticipationSource(session.id, sourceId)?.source.provenance).toEqual(
        expected,
      );

      const lines: MeetingTranscriptSnapshot["lines"] = [];
      for (const line of snapshot.lines) {
        lines.push({
          ...line,
          provenance: testMeetingObservation({
            observationId: "later-observation",
            observedAt: new Date(firstObservedAt + 119_999).toISOString(),
            self: "self",
          }),
        });
      }
      snapshot = { ...snapshot, lines };
      vi.setSystemTime(firstObservedAt + 119_999);
      const retained = await runtime.transcript(session.id);
      expect(retained.lines?.map((line) => line.provenance)).toEqual([expected, expected]);
      expect(runtime.participationContext(session.id)).toMatchObject({
        sourceOrder: 1,
        sources: [{ sourceId, order: 1, provenance: expected }],
      });
      expect(() => inspected!.assertCurrent()).not.toThrow();

      vi.setSystemTime(firstObservedAt + 120_001);
      await runtime.transcript(session.id);
      expect(runtime.participationContext(session.id)).toMatchObject({
        sourceOrder: 1,
        sources: [],
      });
      expect(runtime.inspectParticipationSource(session.id, sourceId)).toBeUndefined();
      expect(() => inspected!.assertCurrent()).toThrow("no longer current");
    } finally {
      await runtime.leave(session.id);
    }
  });
});
