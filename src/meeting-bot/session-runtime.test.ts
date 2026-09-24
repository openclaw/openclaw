import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import {
  closeOpenClawStateDatabaseAsync,
  closeOpenClawStateDatabaseForTest,
} from "../state/openclaw-state-db.js";
import { TranscriptsStore } from "../transcripts/store.js";
import { createMeetingSession } from "./session-factory.js";
import {
  createTestRuntime,
  type TestSession,
  type TestJoinContext,
} from "./session-runtime.test-support.js";

describe("createMeetingSession", () => {
  it.each([
    {
      mode: "agent" as const,
      provider: undefined,
      transcriptionProvider: "deepgram",
    },
    {
      mode: "bidi" as const,
      provider: "openai-realtime",
      transcriptionProvider: undefined,
    },
  ])("preserves $mode realtime session fields", ({ mode, provider, transcriptionProvider }) => {
    const session = createMeetingSession({
      platform: {
        id: "test-meeting",
        displayName: "Test Meeting",
        logScope: "[test-meeting]",
        agentConsult: {
          surface: "a test meeting",
          userLabel: "Participant",
          assistantLabel: "Agent",
          questionSourceLabel: "participant",
          workingResponseLabel: "participant",
          extraSystemPrompt: "Answer briefly.",
        },
        session: {
          idPrefix: "test_meeting",
          participantIdentity: (transport) => `Test participant via ${transport}`,
        },
      },
      config: {
        realtime: {
          provider: "deepgram",
          voiceProvider: "openai-realtime",
          transcriptionProvider: "deepgram",
          model: "realtime-model",
          toolPolicy: "safe-read-only",
        },
      },
      resolved: {
        url: "https://meeting.example/room",
        transport: "chrome",
        mode,
        agentId: "operator",
      },
      createdAt: "2026-07-22T00:00:00.000Z",
    });

    expect(session).toMatchObject({
      id: expect.stringMatching(/^test_meeting_/),
      state: "active",
      participantIdentity: "Test participant via chrome",
      realtime: {
        enabled: true,
        strategy: mode,
        provider,
        model: mode === "bidi" ? "realtime-model" : undefined,
        transcriptionProvider,
        toolPolicy: "safe-read-only",
      },
      notes: [],
    });
  });
});

const tempDirs: string[] = [];

afterEach(async () => {
  vi.useRealTimers();
  await closeOpenClawStateDatabaseAsync();
  closeOpenClawStateDatabaseForTest();
  await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { force: true, recursive: true })));
});

describe("MeetingSessionRuntime durable transcripts", () => {
  const policyTempDirs = useAutoCleanupTempDirTracker(afterEach);

  it.each([false, true])(
    "suspends durable notes without leaving and resumes past disabled captions (failed finalization: %s)",
    async (failFinalization) => {
      const stateDir = policyTempDirs.make("openclaw-meeting-policy-");
      const lines = [{ text: "before suspension" }];
      const releaseBrowserTab = vi.fn(async () => true);
      const captureTranscript = vi.fn(async () => ({
        droppedLines: 0,
        epoch: "same-live-page",
        lines: [...lines],
      }));
      const { runtime } = createTestRuntime({
        captureTranscript,
        durableTranscripts: { stateDir },
        releaseBrowserTab,
        joinTransport: async ({ session }) => {
          session.browser = {
            launched: true,
            tab: { targetId: "policy-tab", openedByPlugin: true },
          };
          return {};
        },
      });
      const { session } = await runtime.join({
        url: "https://meeting.example/policy",
        agentId: "notes-agent",
      });
      const store = new TranscriptsStore(path.join(stateDir, "transcripts"), {
        env: { ...process.env, OPENCLAW_STATE_DIR: stateDir },
      });
      const writeSession = store.writeSession.bind(store);
      const fault = vi
        .spyOn(TranscriptsStore.prototype, "writeSession")
        .mockImplementation(async (descriptor) => {
          if (failFinalization && descriptor.stoppedAt) {
            throw new Error("metadata unavailable");
          }
          return writeSession(descriptor);
        });
      lines.push({ text: "accepted final caption" });
      const disabling = runtime.reconcileTranscriptPolicy(false);
      await expect(
        runtime.startTranscriptSource({
          session: {
            sessionId: "late-subscriber",
            source: {
              providerId: "test-meeting",
              agentId: session.agentId,
              meetingUrl: session.url,
            },
            startedAt: session.createdAt,
          },
          onUtterance: vi.fn(),
        }),
      ).resolves.toMatchObject({ ok: false });
      if (failFinalization) {
        await expect(disabling).rejects.toThrow("metadata unavailable");
      } else {
        await disabling;
      }
      fault.mockRestore();
      expect(session.state).toBe("active");
      expect(releaseBrowserTab).not.toHaveBeenCalled();
      expect(captureTranscript).not.toHaveBeenCalledWith({ finalize: true });

      lines.push({ text: "while disabled" });
      await runtime.reconcileTranscriptPolicy(true);
      lines.push({ text: "after resuming" });
      await runtime.leave(session.id);

      const saved = await store.readSession(session.id);
      expect(saved?.stoppedAt).toEqual(expect.any(String));
      expect((await store.readUtterancesForSession(saved!)).map((line) => line.text)).toEqual([
        "before suspension",
        "accepted final caption",
        "after resuming",
      ]);
      expect(await store.readSummary(saved!)).toMatchObject({ summary: { utteranceCount: 3 } });
      expect(releaseBrowserTab).toHaveBeenCalledOnce();
    },
  );

  it("persists joined agent-mode captions and writes summary rows on leave", async () => {
    const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-meeting-notes-"));
    tempDirs.push(stateDir);
    const snapshots = [
      {
        droppedLines: 0,
        epoch: "page-1",
        lines: [
          {
            at: "2026-07-23T12:00:00.000Z",
            speaker: "Avery",
            text: "We decided to ship the durable notes bridge.",
          },
        ],
      },
      {
        droppedLines: 0,
        epoch: "page-1",
        lines: [
          {
            at: "2026-07-23T12:00:00.000Z",
            speaker: "Avery",
            text: "We decided to ship the durable notes bridge.",
          },
          {
            at: "2026-07-23T12:00:05.000Z",
            speaker: "Blake",
            text: "Action: follow up with the docs.",
          },
        ],
      },
    ];
    const { runtime } = createTestRuntime({
      captureTranscript: async () => snapshots.shift(),
      durableTranscripts: { stateDir },
      releaseBrowserTab: async () => true,
      joinTransport: async ({ session }) => {
        session.browser = {
          launched: true,
          tab: { targetId: "notes-tab", openedByPlugin: true },
        };
        return {};
      },
    });

    const { session } = await runtime.join({
      url: "https://meeting.example/notes?context=opaque-value",
      agentId: "notes-agent",
    });
    await expect(
      runtime.startTranscriptSource({
        session: {
          sessionId: "external-mismatch",
          source: {
            providerId: "test-meeting",
            agentId: "notes-agent",
            channelId: "another-session",
            meetingUrl: session.url,
          },
          startedAt: session.createdAt,
        },
        onUtterance: vi.fn(),
      }),
    ).resolves.toMatchObject({ ok: false });
    await expect(
      runtime.startTranscriptSource({
        session: {
          sessionId: "external-agent-mismatch",
          source: {
            providerId: "test-meeting",
            agentId: "another-agent",
            meetingUrl: session.url,
          },
          startedAt: session.createdAt,
        },
        onUtterance: vi.fn(),
      }),
    ).resolves.toMatchObject({
      ok: false,
      error: "No active meeting session matches the transcript source.",
    });
    await runtime.leave(session.id);

    const store = new TranscriptsStore(path.join(stateDir, "transcripts"), {
      env: { ...process.env, OPENCLAW_STATE_DIR: stateDir },
    });
    const storedSession = await store.readSession(session.id);
    expect(storedSession).toMatchObject({
      sessionId: session.id,
      source: { providerId: "test-meeting", meetingUrl: "https://meeting.example/notes" },
      metadata: { agentId: "notes-agent", meetingSessionId: session.id, mode: "agent" },
      stoppedAt: expect.any(String),
    });
    expect(await store.readUtterancesForSession(storedSession!)).toMatchObject([
      { speaker: { label: "Avery" }, text: "We decided to ship the durable notes bridge." },
      { speaker: { label: "Blake" }, text: "Action: follow up with the docs." },
    ]);
    expect(await store.readSummary(storedSession!)).toMatchObject({
      summary: {
        actionItems: [
          "Avery: We decided to ship the durable notes bridge.",
          "Blake: Action: follow up with the docs.",
        ],
        decisions: ["Avery: We decided to ship the durable notes bridge."],
        utteranceCount: 2,
      },
    });
  });

  it("keeps transcribe finalization when durable session startup fails", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-meeting-notes-"));
    tempDirs.push(tempDir);
    const blockedStateDir = path.join(tempDir, "not-a-directory");
    await fs.writeFile(blockedStateDir, "blocked", "utf8");
    const captureTranscript = vi.fn(async () => ({ droppedLines: 0, lines: [] }));
    const { runtime } = createTestRuntime({
      captureTranscript,
      durableTranscripts: { stateDir: blockedStateDir },
      transcribe: true,
      releaseBrowserTab: async () => true,
      joinTransport: async ({ session }) => {
        session.browser = {
          launched: true,
          tab: { targetId: "notes-tab", openedByPlugin: true },
        };
        return {};
      },
    });

    const { session } = await runtime.join({
      url: "https://meeting.example/notes",
      agentId: "notes-agent",
    });
    await runtime.leave(session.id);

    expect(captureTranscript).toHaveBeenCalledTimes(2);
    expect(captureTranscript).toHaveBeenCalledWith({ finalize: true });
  });

  it("does not let subscriber delivery failure block meeting leave", async () => {
    const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-meeting-notes-"));
    tempDirs.push(stateDir);
    const empty = { droppedLines: 0, epoch: "page-1", lines: [] };
    const final = {
      droppedLines: 0,
      epoch: "page-1",
      lines: [{ speaker: "Avery", text: "Final decision" }],
    };
    const snapshots = [empty, final];
    const releaseBrowserTab = vi.fn(async () => true);
    const { runtime } = createTestRuntime({
      captureTranscript: async () => snapshots.shift(),
      durableTranscripts: { stateDir },
      transcribe: true,
      releaseBrowserTab,
      joinTransport: async ({ session }) => {
        session.browser = {
          launched: true,
          tab: { targetId: "notes-tab", openedByPlugin: true },
        };
        return {};
      },
    });
    const { session } = await runtime.join({
      url: "https://meeting.example/notes",
      agentId: "notes-agent",
    });
    const onUtterance = vi.fn(async () => {
      throw new Error("subscriber unavailable");
    });
    await runtime.startTranscriptSource({
      session: {
        sessionId: "external-final",
        source: {
          providerId: "test-meeting",
          agentId: "notes-agent",
          meetingUrl: session.url,
        },
        startedAt: session.createdAt,
      },
      onUtterance,
    });

    await expect(runtime.leave(session.id)).resolves.toMatchObject({ found: true });
    expect(session.state).toBe("ended");
    expect(releaseBrowserTab).toHaveBeenCalledOnce();

    const store = new TranscriptsStore(path.join(stateDir, "transcripts"), {
      env: { ...process.env, OPENCLAW_STATE_DIR: stateDir },
    });
    const stored = await store.readSession(session.id);
    expect(await store.readUtterancesForSession(stored!)).toHaveLength(1);
    expect(await store.readSummary(stored!)).toMatchObject({
      summary: { utteranceCount: 1 },
    });
    expect(onUtterance).toHaveBeenCalledOnce();
  });
});

describe("MeetingSessionRuntime failed joins", () => {
  it.each([false, true])(
    "retries failed joins while preserving acquired browser custody: %s",
    async (acquiredTab) => {
      const launchError = new Error("browser launch failed");
      let launches = 0;
      let releaseAllowed = false;
      const request = { url: "https://meeting.example/retry", agentId: "main" };
      const { runtime } = createTestRuntime({
        releaseBrowserTab: async (session) => {
          if (!session.browser?.tab || !releaseAllowed) {
            return false;
          }
          session.browser.tab = undefined;
          return true;
        },
        joinTransport: async ({ session }) => {
          launches += 1;
          if (launches > 1 || acquiredTab) {
            session.browser = {
              launched: true,
              tab: { targetId: `${session.id}-retry-tab`, openedByPlugin: true },
            };
          }
          if (launches === 1) {
            throw launchError;
          }
          return {};
        },
      });
      try {
        await expect(runtime.join(request)).rejects.toBe(launchError);
        const pending = runtime.list()[0];
        expect(runtime.list()).toHaveLength(acquiredTab ? 1 : 0);
        const retried = await runtime.join(request);
        expect(retried.session.state).toBe("active");
        expect(launches).toBe(2);
        if (pending) {
          expect(pending.browser?.tab).toBeDefined();
          releaseAllowed = true;
          await expect(runtime.leave(pending.id)).resolves.toMatchObject({ browserLeft: true });
        }
        expect(runtime.list()).toEqual([retried.session]);
      } finally {
        releaseAllowed = true;
        for (const session of runtime.list()) {
          await runtime.leave(session.id);
        }
      }
    },
  );

  it("cleans an externally ended reusable session before replacing it", async () => {
    const stop = vi.fn(async () => {});
    const releaseBrowserTab = vi.fn(async () => true);
    const joinTransport = vi.fn(
      async ({ session, context }: { session: TestSession; context: TestJoinContext }) => {
        session.browser = {
          launched: true,
          tab: { targetId: session.id, openedByPlugin: true },
        };
        context.attachRuntimeHandles(session, { stop });
        return {};
      },
    );
    const { runtime } = createTestRuntime({
      joinTransport,
      refreshReusableSession: async (session) => {
        session.state = "ended";
      },
      releaseBrowserTab,
    });
    const first = await runtime.join({ url: "https://meeting.example/room", agentId: "main" });

    const replacement = await runtime.join({
      url: "https://meeting.example/room",
      agentId: "main",
    });

    expect(first.session.state).toBe("ended");
    expect(replacement.session.id).not.toBe(first.session.id);
    expect(stop).toHaveBeenCalledOnce();
    expect(releaseBrowserTab).not.toHaveBeenCalled();
    expect(joinTransport).toHaveBeenCalledTimes(2);
  });

  it("stops attached transport handles and releases the partial browser tab", async () => {
    const joinError = new Error("transport setup failed");
    const stop = vi.fn(async () => {});
    let releaseAttempts = 0;
    const releaseBrowserTab = vi.fn(async (session: TestSession) => {
      if (releaseAttempts++ === 0) {
        return false;
      }
      if (session.browser) {
        session.browser.tab = undefined;
      }
      return true;
    });
    const { createdSessions, runtime } = createTestRuntime({
      releaseBrowserTab,
      joinTransport: async ({ session, context }) => {
        session.browser = {
          launched: true,
          tab: { targetId: "partial-tab", openedByPlugin: true },
        };
        context.attachRuntimeHandles(session, { stop });
        throw joinError;
      },
    });

    await expect(
      runtime.join({ url: "https://meeting.example/room", agentId: "main" }),
    ).rejects.toBe(joinError);

    expect(stop).toHaveBeenCalledOnce();
    expect(releaseBrowserTab).toHaveBeenCalledTimes(2);
    expect(createdSessions[0]).toMatchObject({ state: "ended", browser: { tab: undefined } });
    expect(runtime.list()).toEqual([]);
  });

  it("retries transport cleanup for an unpublished failed join", async () => {
    const joinError = new Error("transport setup failed");
    const stopError = new Error("transport stop failed");
    const stop = vi
      .fn<() => Promise<void>>()
      .mockRejectedValueOnce(stopError)
      .mockResolvedValueOnce();
    const releaseBrowserTab = vi.fn(async (session: TestSession) => {
      if (session.browser) {
        session.browser.tab = undefined;
      }
      return true;
    });
    const { runtime } = createTestRuntime({
      releaseBrowserTab,
      joinTransport: async ({ session, context }) => {
        session.browser = {
          launched: true,
          tab: { targetId: "partial-tab", openedByPlugin: true },
        };
        context.attachRuntimeHandles(session, { stop });
        throw joinError;
      },
    });

    await expect(
      runtime.join({ url: "https://meeting.example/room", agentId: "main" }),
    ).rejects.toBe(joinError);

    expect(stop).toHaveBeenCalledTimes(2);
    expect(releaseBrowserTab).toHaveBeenCalledOnce();
    expect(runtime.list()).toEqual([]);
  });

  it.each([true, false])(
    "retains a failed join with live cleanup for a later leave retry (tab: %s)",
    async (acquiredTab) => {
      const joinError = new Error("transport setup failed");
      const cleanupError = new Error("transport cleanup still pending");
      let resourceLive = true;
      let releaseStop = false;
      const stop = vi.fn(async () => {
        if (!releaseStop) {
          throw cleanupError;
        }
        resourceLive = false;
      });
      const { createdSessions, runtime } = createTestRuntime({
        releaseBrowserTab: async (session) => {
          if (!session.browser?.tab) {
            return false;
          }
          session.browser.tab = undefined;
          return true;
        },
        joinTransport: async ({ session, context }) => {
          if (acquiredTab) {
            session.browser = {
              launched: true,
              tab: { targetId: "partial-tab", openedByPlugin: true },
            };
          }
          context.attachRuntimeHandles(session, { stop });
          throw joinError;
        },
      });
      try {
        await expect(
          runtime.join({ url: "https://meeting.example/failed", agentId: "main" }),
        ).rejects.toBe(joinError);
        expect(resourceLive).toBe(true);
        expect(stop).toHaveBeenCalledTimes(2);
        const original = createdSessions[0];
        expect(original).toBeDefined();
        if (!original) {
          throw new Error("Expected the original meeting session");
        }
        await expect(runtime.status(original.id)).resolves.toMatchObject({ found: true });
        await expect(runtime.join({ url: original.url, agentId: "main" })).rejects.toBe(
          cleanupError,
        );
        expect(createdSessions).toHaveLength(1);
        expect(resourceLive).toBe(true);
        expect(stop).toHaveBeenCalledTimes(3);
        releaseStop = true;
        await runtime.leave(original.id);
        expect(resourceLive).toBe(false);
        expect(stop).toHaveBeenCalledTimes(4);
        await expect(runtime.status(original.id)).resolves.toMatchObject({ found: false });
      } finally {
        releaseStop = true;
        if (resourceLive) {
          await stop();
        }
      }
    },
  );

  it("retries unprocessed retained tabs after settlement rejects", async () => {
    const settlementError = new Error("retained release rejected");
    const oldStop = vi.fn(async () => {});
    const replacementStop = vi.fn(async () => {});
    const releaseOrder: string[] = [];
    let oldReleaseAttempts = 0;
    const releaseBrowserTab = vi.fn(async (session: TestSession) => {
      releaseOrder.push(session.id);
      if (session.id === "session-1" && oldReleaseAttempts++ === 0) {
        throw settlementError;
      }
      if (session.browser) {
        session.browser.tab = undefined;
      }
      return true;
    });
    const { createdSessions, runtime } = createTestRuntime({
      releaseBrowserTab,
      joinTransport: async ({ session, context }) => {
        const first = session.id === "session-1";
        session.browser = {
          launched: true,
          tab: {
            targetId: first ? "retained-tab" : "replacement-tab",
            openedByPlugin: true,
          },
        };
        context.attachRuntimeHandles(session, { stop: first ? oldStop : replacementStop });
        return {};
      },
    });
    await runtime.join({ url: "https://meeting.example/room", agentId: "support" });

    await expect(
      runtime.join({ url: "https://meeting.example/room", agentId: "main" }),
    ).rejects.toBe(settlementError);

    expect(oldStop).toHaveBeenCalledOnce();
    expect(replacementStop).toHaveBeenCalledOnce();
    expect(releaseOrder).toEqual(["session-1", "session-2", "session-1"]);
    expect(createdSessions[0]?.browser?.tab).toBeUndefined();
    expect(createdSessions[1]).toMatchObject({ state: "ended", browser: { tab: undefined } });
  });

  it("retries retained cleanup when stopping the previous session rejects", async () => {
    const stopError = new Error("previous transport stop failed");
    const settlementError = new Error("retained release rejected");
    const oldStop = vi.fn(async () => {
      throw stopError;
    });
    let releaseAttempts = 0;
    const releaseBrowserTab = vi.fn(async (session: TestSession) => {
      if (releaseAttempts++ === 0) {
        throw settlementError;
      }
      if (session.browser) {
        session.browser.tab = undefined;
      }
      return true;
    });
    const joinTransport = vi.fn(
      async ({ session, context }: { session: TestSession; context: TestJoinContext }) => {
        session.browser = {
          launched: true,
          tab: { targetId: "retained-tab", openedByPlugin: true },
        };
        context.attachRuntimeHandles(session, { stop: oldStop });
        return {};
      },
    );
    const { createdSessions, runtime } = createTestRuntime({
      releaseBrowserTab,
      joinTransport,
    });
    await runtime.join({ url: "https://meeting.example/room", agentId: "support" });

    await expect(
      runtime.join({ url: "https://meeting.example/room", agentId: "main" }),
    ).rejects.toBe(stopError);

    expect(joinTransport).toHaveBeenCalledOnce();
    expect(oldStop).toHaveBeenCalledOnce();
    expect(releaseBrowserTab).toHaveBeenCalledTimes(2);
    expect(createdSessions[0]).toMatchObject({ state: "ended", browser: { tab: undefined } });
  });
});

describe("MeetingSessionRuntime leave cleanup", () => {
  it.each([false, true])(
    "allows same-URL retry after ordinary leave according to owned browser custody: %s",
    async (acquiredTab) => {
      let releaseAllowed = false;
      let launches = 0;
      const request = { url: "https://meeting.example/ordinary", agentId: "main" };
      const { runtime } = createTestRuntime({
        releaseBrowserTab: async (session) => {
          if (!session.browser?.tab || !releaseAllowed) {
            return false;
          }
          session.browser.tab = undefined;
          return true;
        },
        joinTransport: async ({ session }) => {
          launches += 1;
          session.browser = {
            launched: acquiredTab,
            ...(acquiredTab
              ? { tab: { targetId: `${session.id}-ordinary-tab`, openedByPlugin: true } }
              : {}),
          };
          return {};
        },
      });
      try {
        const first = await runtime.join(request);
        await expect(runtime.leave(first.session.id)).resolves.toMatchObject({
          browserLeft: false,
        });
        const second = await runtime.join(request);
        expect(second.session.id).not.toBe(first.session.id);
        expect(second.session.state).toBe("active");
        expect(launches).toBe(2);
        if (acquiredTab) {
          expect(first.session.browser?.tab).toBeDefined();
          releaseAllowed = true;
          await expect(runtime.leave(first.session.id)).resolves.toMatchObject({
            browserLeft: true,
          });
        }
      } finally {
        releaseAllowed = true;
        for (const session of runtime.list()) {
          await runtime.leave(session.id);
        }
      }
    },
  );

  it("clears stale in-call health after confirmed browser departure", async () => {
    const { runtime } = createTestRuntime({
      releaseBrowserTab: async () => true,
      joinTransport: async ({ session }) => {
        session.browser = {
          launched: true,
          health: {
            inCall: true,
            micMuted: false,
            manualAction: { reason: "old-action", message: "old action" },
            speechReady: true,
            speechBlockedMessage: "old speech block",
            speechBlockedReason: "old-speech-block",
          },
          tab: { targetId: "leave-tab", openedByPlugin: true },
        };
        return {};
      },
    });
    const { session } = await runtime.join({
      url: "https://meeting.example/room",
      agentId: "main",
    });

    await expect(runtime.leave(session.id)).resolves.toMatchObject({
      browserLeft: true,
      session: {
        browser: {
          health: {
            inCall: false,
            manualAction: undefined,
            speechReady: false,
          },
        },
      },
    });
    expect(session.browser?.health?.manualAction).toBeUndefined();
    expect(session.browser?.health?.micMuted).toBeUndefined();
    expect(session.browser?.health?.speechBlockedReason).toBeUndefined();
    expect(session.browser?.health?.speechBlockedMessage).toBeUndefined();
  });

  it("retries a failed transport stop without repeating settled browser cleanup", async () => {
    const stopError = new Error("transport stop failed");
    const stop = vi
      .fn<() => Promise<void>>()
      .mockRejectedValueOnce(stopError)
      .mockResolvedValueOnce();
    const releaseBrowserTab = vi.fn(async (session: TestSession) => {
      if (session.browser) {
        session.browser.tab = undefined;
      }
      return true;
    });
    const { runtime } = createTestRuntime({
      releaseBrowserTab,
      joinTransport: async ({ session, context }) => {
        session.browser = {
          launched: true,
          tab: { targetId: "leave-tab", openedByPlugin: true },
        };
        context.attachRuntimeHandles(session, { stop });
        return {};
      },
    });
    const { session } = await runtime.join({
      url: "https://meeting.example/room",
      agentId: "main",
    });

    await expect(runtime.leave(session.id)).rejects.toBe(stopError);
    await expect(runtime.leave(session.id)).resolves.toMatchObject({
      found: true,
      browserLeft: true,
    });

    expect(stop).toHaveBeenCalledTimes(2);
    expect(releaseBrowserTab).toHaveBeenCalledOnce();
  });

  it("retries browser cleanup that reported an unsuccessful leave", async () => {
    const stop = vi.fn(async () => {});
    const releaseBrowserTab = vi.fn().mockResolvedValueOnce(false).mockResolvedValueOnce(true);
    const { runtime } = createTestRuntime({
      releaseBrowserTab,
      joinTransport: async ({ session, context }) => {
        session.browser = {
          launched: true,
          tab: { targetId: "retry-tab", openedByPlugin: true },
        };
        context.attachRuntimeHandles(session, { stop });
        return {};
      },
    });
    const { session } = await runtime.join({
      url: "https://meeting.example/room",
      agentId: "main",
    });

    await expect(runtime.leave(session.id)).resolves.toMatchObject({
      found: true,
      browserLeft: false,
    });
    await expect(runtime.leave(session.id)).resolves.toMatchObject({
      found: true,
      browserLeft: true,
    });

    expect(stop).toHaveBeenCalledOnce();
    expect(releaseBrowserTab).toHaveBeenCalledTimes(2);
  });
});

describe("MeetingSessionRuntime speech readiness", () => {
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
