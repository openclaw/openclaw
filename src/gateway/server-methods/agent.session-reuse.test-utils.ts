// Imported by agent.test.ts to retain its existing mocked module graph.
import fs from "node:fs/promises";
import { afterEach, describe, expect, it, vi } from "vitest";
import { withTestDir } from "../../test-helpers/temp-dir.js";
import {
  getAgentTestMocks,
  type AgentParams,
  setDateOnlyFakeClockActive,
  requireValue,
  expectSqliteSessionFileMarkerForEntry,
  mockMainSessionEntry,
  buildExistingMainStoreEntry,
  runMainAgent,
  runMainAgentAndCaptureEntry,
  waitForAgentCommandCall,
  waitForAgentCommandCallAfter,
  invokeAgent,
  describe0AfterEach0,
} from "./agent.test-harness.js";

const mocks = getAgentTestMocks();

describe("gateway agent handler", () => {
  afterEach(describe0AfterEach0);

  it("preserves ACP metadata from the current stored session entry", async () => {
    const existingAcpMeta = {
      backend: "acpx",
      agent: "codex",
      runtimeSessionName: "runtime-1",
      mode: "persistent",
      state: "idle",
      lastActivityAt: Date.now(),
    };

    mockMainSessionEntry({
      acp: existingAcpMeta,
    });

    let capturedEntry: Record<string, unknown> | undefined;
    mocks.updateSessionStore.mockImplementation(async (_path, updater) => {
      const store: Record<string, unknown> = {
        "agent:main:main": buildExistingMainStoreEntry({ acp: existingAcpMeta }),
      };
      const result = await updater(store);
      capturedEntry = store["agent:main:main"] as Record<string, unknown>;
      return result;
    });

    mocks.agentCommand.mockResolvedValue({
      payloads: [{ text: "ok" }],
      meta: { durationMs: 100 },
    });

    await runMainAgent("test", "test-idem-acp-meta");

    expect(mocks.updateSessionStore).toHaveBeenCalled();
    expect(requireValue(capturedEntry, "updated session entry missing").acp).toEqual(
      existingAcpMeta,
    );
  });

  it("clears automatic recovery quarantine state when a user turn rotates the session id", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    setDateOnlyFakeClockActive(true);
    vi.setSystemTime(new Date("2026-05-07T12:00:00.000Z"));
    const staleEntry = {
      sessionId: "quarantined-session-id",
      updatedAt: 0,
      sessionStartedAt: 0,
      lastInteractionAt: 0,
      abortedLastRun: true,
      restartRecoveryRuns: [
        { runId: "initial-wedged-run", lifecycleGeneration: "gen-1" },
        { runId: "recovery-run-1", lifecycleGeneration: "gen-2" },
      ],
      mainRestartRecovery: {
        automaticAttempts: 2,
        lastAttemptAt: 3,
        lastRunId: "recovery-run-1",
      },
      subagentRecovery: {
        automaticAttempts: 2,
        lastAttemptAt: 3,
        wedgedAt: 4,
        wedgedReason: "automatic_attempt_budget_exceeded",
      },
    };
    mockMainSessionEntry(staleEntry);

    const capturedEntry = await runMainAgentAndCaptureEntry("test-idem-rotated-recovery-clear");

    expect(capturedEntry.sessionId).not.toBe("quarantined-session-id");
    expect(capturedEntry.abortedLastRun).toBeUndefined();
    expect(capturedEntry.restartRecoveryRuns).toBeUndefined();
    expect(capturedEntry.mainRestartRecovery).toBeUndefined();
    expect(capturedEntry.subagentRecovery).toEqual({
      automaticAttempts: 2,
      lastAttemptAt: 3,
      wedgedAt: 4,
      wedgedReason: "automatic_attempt_budget_exceeded",
    });
  });

  it("drops a stale transcript path when a stale session rotates ids", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    setDateOnlyFakeClockActive(true);
    vi.setSystemTime(new Date("2026-05-07T12:00:00.000Z"));
    const staleEntry = {
      sessionId: "old-session-id",
      sessionFile: "/tmp/openclaw/agents/main/sessions/old-session-id.jsonl",
      updatedAt: 0,
      sessionStartedAt: 0,
    };
    mockMainSessionEntry(staleEntry);

    let capturedEntry: Record<string, unknown> | undefined;
    mocks.updateSessionStore.mockImplementation(async (_path, updater) => {
      const store: Record<string, unknown> = {
        "agent:main:main": { ...staleEntry },
      };
      const result = await updater(store);
      capturedEntry = result as Record<string, unknown>;
      return result;
    });
    mocks.agentCommand.mockResolvedValue({
      payloads: [{ text: "ok" }],
      meta: { durationMs: 100 },
    });

    await runMainAgent("test", "test-idem-stale-transcript");

    expect(capturedEntry?.sessionId).not.toBe("old-session-id");
    expectSqliteSessionFileMarkerForEntry(capturedEntry);
  });

  it("rotates a failed session instead of resuming when its transcript is missing", async () => {
    const now = Date.parse("2026-05-18T09:45:00.000Z");
    vi.useFakeTimers({ toFake: ["Date"] });
    setDateOnlyFakeClockActive(true);
    vi.setSystemTime(now);
    const missingTranscriptEntry = {
      sessionId: "failed-missing-session-id",
      sessionFile: "/tmp/openclaw/missing/failed-missing-session-id.jsonl",
      status: "failed",
      updatedAt: now,
      sessionStartedAt: now,
      lastInteractionAt: now,
      startedAt: now - 2_000,
      endedAt: now - 1_000,
      runtimeMs: 1_000,
      abortedLastRun: true,
    };
    mockMainSessionEntry(missingTranscriptEntry);

    const capturedEntry = await runMainAgentAndCaptureEntry("test-idem-failed-missing-transcript");

    const call = await waitForAgentCommandCall<{ sessionId?: string }>();
    expect(call.sessionId).not.toBe("failed-missing-session-id");
    expect(capturedEntry?.sessionId).not.toBe("failed-missing-session-id");
    expect(capturedEntry?.status).toBeUndefined();
    expect(capturedEntry?.startedAt).toBeUndefined();
    expect(capturedEntry?.endedAt).toBeUndefined();
    expect(capturedEntry?.runtimeMs).toBeUndefined();
    expect(capturedEntry?.abortedLastRun).toBeUndefined();
    expectSqliteSessionFileMarkerForEntry(capturedEntry);
  });

  it.each([
    { name: "status-done row", status: "done" as const, expectReuse: true },
    { name: "status-killed row", status: "killed" as const, expectReuse: false },
    { name: "endedAt-only row", status: undefined, expectReuse: false },
  ])(
    "handles a terminal main session from a $name when its transcript is newer",
    async (scenario) => {
      const now = Date.parse("2026-05-18T09:47:00.000Z");
      vi.useFakeTimers({ toFake: ["Date"] });
      setDateOnlyFakeClockActive(true);
      vi.setSystemTime(now);
      mocks.readTranscriptMutationStateSync.mockReturnValue({
        observedAt: null,
        updatedAt: now - 1_000,
      });

      await withTestDir({ prefix: "openclaw-gateway-terminal-main-newer-" }, async (root) => {
        const sessionsDir = `${root}/sessions`;
        const sessionFile = "terminal-main-session.jsonl";
        mocks.loadSessionEntry.mockReturnValue({
          cfg: {},
          storePath: `${sessionsDir}/sessions.json`,
          entry: {
            sessionId: "terminal-main-session",
            sessionFile,
            ...(scenario.status ? { status: scenario.status } : {}),
            updatedAt: now - 10_000,
            sessionStartedAt: now - 60_000,
            lastInteractionAt: now - 10_000,
            startedAt: now - 20_000,
            endedAt: now - 15_000,
            runtimeMs: 5_000,
            cliSessionBindings: {
              "claude-cli": { sessionId: "old-claude-cli-session" },
              "codex-cli": { sessionId: "old-codex-cli-session" },
            },
            cliSessionIds: {
              "claude-cli": "old-claude-cli-session",
              "codex-cli": "old-codex-cli-session",
            },
            claudeCliSessionId: "old-claude-cli-session",
          },
          canonicalKey: "agent:main:main",
        });

        const commandCallCount = mocks.agentCommand.mock.calls.length;
        const capturedEntry = await runMainAgentAndCaptureEntry(
          "test-idem-terminal-main-newer-transcript",
        );

        const call = await waitForAgentCommandCallAfter<{ sessionId?: string }>(commandCallCount);
        if (scenario.expectReuse) {
          expect(call.sessionId).toBe("terminal-main-session");
          expect(capturedEntry?.sessionId).toBe("terminal-main-session");
          expect(mocks.readTranscriptMutationStateSync).not.toHaveBeenCalled();
          return;
        }
        expect(call.sessionId).not.toBe("terminal-main-session");
        expect(capturedEntry?.sessionId).not.toBe("terminal-main-session");
        expect(capturedEntry?.status).toBeUndefined();
        expect(capturedEntry?.startedAt).toBeUndefined();
        expect(capturedEntry?.endedAt).toBeUndefined();
        expect(capturedEntry?.runtimeMs).toBeUndefined();
        expectSqliteSessionFileMarkerForEntry(capturedEntry);
        expect(capturedEntry?.cliSessionBindings).toBeUndefined();
        expect(capturedEntry?.cliSessionIds).toBeUndefined();
        expect(capturedEntry?.claudeCliSessionId).toBeUndefined();
      });
    },
  );

  it("reuses terminal main sessions when the fresh store row has the transcript marker", async () => {
    const now = Date.parse("2026-05-18T09:47:30.000Z");
    vi.useFakeTimers({ toFake: ["Date"] });
    setDateOnlyFakeClockActive(true);
    vi.setSystemTime(now);

    await withTestDir({ prefix: "openclaw-gateway-terminal-main-fresh-marker-" }, async (root) => {
      const sessionsDir = `${root}/sessions`;
      await fs.mkdir(sessionsDir, { recursive: true });
      const sessionFile = "terminal-main-session.jsonl";
      const transcriptPath = `${sessionsDir}/${sessionFile}`;
      await fs.writeFile(
        transcriptPath,
        `${JSON.stringify({ type: "session", id: "terminal-main-session" })}\n`,
        "utf8",
      );
      await fs.utimes(transcriptPath, new Date(now - 1_000), new Date(now - 1_000));
      const staleEntry = {
        sessionId: "terminal-main-session",
        sessionFile,
        status: "done",
        updatedAt: now - 10_000,
        cliSessionBindings: {
          "claude-cli": { sessionId: "existing-claude-cli-session" },
        },
        cliSessionIds: {
          "claude-cli": "existing-claude-cli-session",
        },
        claudeCliSessionId: "existing-claude-cli-session",
      };
      mocks.loadSessionEntry.mockReturnValue({
        cfg: {},
        storePath: `${sessionsDir}/sessions.json`,
        entry: staleEntry,
        canonicalKey: "agent:main:main",
      });
      let capturedEntry: Record<string, unknown> | undefined;
      mocks.updateSessionStore.mockImplementation(async (_path, updater) => {
        const store = {
          "agent:main:main": {
            ...staleEntry,
            updatedAt: now,
          },
        };
        const result = await updater(store);
        capturedEntry = result as Record<string, unknown>;
        return result;
      });
      mocks.agentCommand.mockResolvedValue({
        payloads: [{ text: "ok" }],
        meta: { durationMs: 100 },
      });

      await runMainAgent("hi", "test-idem-terminal-main-fresh-marker");

      const call = await waitForAgentCommandCall<{ sessionId?: string }>();
      expect(call.sessionId).toBe("terminal-main-session");
      expect(capturedEntry?.sessionId).toBe("terminal-main-session");
      expectSqliteSessionFileMarkerForEntry(capturedEntry);
      expect(capturedEntry?.cliSessionIds).toEqual({
        "claude-cli": "existing-claude-cli-session",
      });
      expect(capturedEntry?.claudeCliSessionId).toBe("existing-claude-cli-session");
    });
  });

  it("honors explicit gateway session-id resumes for terminal main rows", async () => {
    const now = Date.parse("2026-05-18T09:48:00.000Z");
    vi.useFakeTimers({ toFake: ["Date"] });
    setDateOnlyFakeClockActive(true);
    vi.setSystemTime(now);

    await withTestDir(
      { prefix: "openclaw-gateway-terminal-main-explicit-resume-" },
      async (root) => {
        const sessionsDir = `${root}/sessions`;
        await fs.mkdir(sessionsDir, { recursive: true });
        const sessionFile = "terminal-main-session.jsonl";
        const transcriptPath = `${sessionsDir}/${sessionFile}`;
        await fs.writeFile(
          transcriptPath,
          `${JSON.stringify({ type: "session", id: "terminal-main-session" })}\n`,
          "utf8",
        );
        await fs.utimes(transcriptPath, new Date(now - 1_000), new Date(now - 1_000));
        const existingEntry = {
          sessionId: "terminal-main-session",
          sessionFile,
          status: "done",
          updatedAt: now - 10_000,
          sessionStartedAt: now - 60_000,
          lastInteractionAt: now - 10_000,
          startedAt: now - 20_000,
          endedAt: now - 15_000,
          runtimeMs: 5_000,
        };
        mocks.loadSessionEntry.mockReturnValue({
          cfg: {},
          storePath: `${sessionsDir}/sessions.json`,
          entry: existingEntry,
          canonicalKey: "agent:main:main",
        });
        let capturedEntry: Record<string, unknown> | undefined;
        mocks.updateSessionStore.mockImplementation(async (_path, updater) => {
          const store: Record<string, unknown> = {
            "agent:main:main": { ...existingEntry },
          };
          const result = await updater(store);
          capturedEntry = result as Record<string, unknown>;
          return result;
        });
        mocks.agentCommand.mockResolvedValue({
          payloads: [{ text: "ok" }],
          meta: { durationMs: 100 },
        });

        await invokeAgent({
          message: "resume terminal main",
          agentId: "main",
          sessionKey: "agent:main:main",
          sessionId: "terminal-main-session",
          idempotencyKey: "test-idem-terminal-main-explicit-resume",
        } as AgentParams);

        const call = await waitForAgentCommandCall<{ sessionId?: string }>();
        expect(call.sessionId).toBe("terminal-main-session");
        expect(capturedEntry?.sessionId).toBe("terminal-main-session");
        expectSqliteSessionFileMarkerForEntry(capturedEntry);
        expect(capturedEntry?.status).toBe("done");
        expect(capturedEntry?.startedAt).toBe(now - 20_000);
        expect(capturedEntry?.endedAt).toBe(now - 15_000);
        expect(capturedEntry?.runtimeMs).toBe(5_000);
      },
    );
  });

  it.each(["heartbeat", "cron"] as const)(
    "preserves terminal main session reuse for %s protocol runs as ordinary automation",
    async (wireKind) => {
      const now = Date.parse("2026-05-18T09:49:00.000Z");
      vi.useFakeTimers({ toFake: ["Date"] });
      setDateOnlyFakeClockActive(true);
      vi.setSystemTime(now);

      await withTestDir({ prefix: "openclaw-gateway-terminal-main-cron-reuse-" }, async (root) => {
        const sessionsDir = `${root}/sessions`;
        await fs.mkdir(sessionsDir, { recursive: true });
        const sessionFile = "terminal-main-cron.jsonl";
        const transcriptPath = `${sessionsDir}/${sessionFile}`;
        await fs.writeFile(
          transcriptPath,
          `${JSON.stringify({ type: "session", id: "terminal-main-session" })}\n`,
          "utf8",
        );
        await fs.utimes(transcriptPath, new Date(now - 1_000), new Date(now - 1_000));
        const existingEntry = {
          sessionId: "terminal-main-session",
          sessionFile,
          status: "done",
          updatedAt: now - 10_000,
          sessionStartedAt: now - 60_000,
          lastInteractionAt: now - 10_000,
          startedAt: now - 20_000,
          endedAt: now - 15_000,
          runtimeMs: 5_000,
        };
        mocks.loadSessionEntry.mockReturnValue({
          cfg: {},
          storePath: `${sessionsDir}/sessions.json`,
          entry: existingEntry,
          canonicalKey: "agent:main:main",
        });

        let capturedEntry: Record<string, unknown> | undefined;
        mocks.updateSessionStore.mockImplementation(async (_path, updater) => {
          const store: Record<string, unknown> = {
            "agent:main:main": { ...existingEntry },
          };
          const result = await updater(store);
          capturedEntry = result as Record<string, unknown>;
          return result;
        });
        mocks.agentCommand.mockResolvedValue({
          payloads: [{ text: "ok" }],
          meta: { durationMs: 100 },
        });

        await invokeAgent({
          message: `${wireKind} probe`,
          agentId: "main",
          sessionKey: "agent:main:main",
          bootstrapContextRunKind: wireKind,
          idempotencyKey: "test-idem-terminal-main-cron-reuse",
        } as AgentParams);

        const call = await waitForAgentCommandCall<{
          sessionId?: string;
          bootstrapContextRunKind?: string;
        }>();
        expect(call.sessionId).toBe("terminal-main-session");
        expect(call.bootstrapContextRunKind).toBe("cron");
        expect(call).not.toHaveProperty("isHeartbeat");
        expect(capturedEntry?.sessionId).toBe("terminal-main-session");
        expectSqliteSessionFileMarkerForEntry(capturedEntry);
      });
    },
  );

  it("rotates a failed session when its default transcript is missing", async () => {
    const now = Date.parse("2026-05-18T09:48:00.000Z");
    vi.useFakeTimers({ toFake: ["Date"] });
    setDateOnlyFakeClockActive(true);
    vi.setSystemTime(now);
    const missingDefaultTranscriptEntry = {
      sessionId: "failed-missing-default-session-id",
      status: "failed",
      updatedAt: now,
      sessionStartedAt: now,
      lastInteractionAt: now,
    };
    mockMainSessionEntry(missingDefaultTranscriptEntry);

    const capturedEntry = await runMainAgentAndCaptureEntry(
      "test-idem-failed-missing-default-transcript",
    );

    const call = await waitForAgentCommandCall<{ sessionId?: string }>();
    expect(call.sessionId).not.toBe("failed-missing-default-session-id");
    expect(capturedEntry?.sessionId).not.toBe("failed-missing-default-session-id");
    expect(capturedEntry?.status).toBeUndefined();
    expectSqliteSessionFileMarkerForEntry(capturedEntry);
  });
});
