import { afterEach, describe, expect, it, vi } from "vitest";
import {
  GENERIC_EXTERNAL_RUN_FAILURE_TEXT,
  HEARTBEAT_EXTERNAL_RUN_FAILURE_TEXT,
} from "../auto-reply/reply/agent-runner-failure-copy.js";
import { readCommitmentsForTest, seedCommitmentsForTest } from "../commitments/store.test-utils.js";
import type { CommitmentRecord } from "../commitments/types.js";
import type { OpenClawConfig } from "../config/config.js";
import { closeOpenClawStateDatabaseForTest } from "../state/openclaw-state-db.js";
import { captureEnv, setTestEnvValue } from "../test-utils/env.js";
import { resetHeartbeatEventsForTest } from "./heartbeat-events.js";
import { runHeartbeatOnce, setHeartbeatsEnabled } from "./heartbeat-runner.js";
import { installHeartbeatRunnerTestRuntime } from "./heartbeat-runner.test-harness.js";
import {
  readSessionStoreForTest,
  seedSessionStore,
  withTempHeartbeatSandbox,
} from "./heartbeat-runner.test-utils.js";
import {
  enqueueSystemEvent,
  peekSystemEventEntries,
  resetSystemEventsForTest,
} from "./system-events.js";

vi.mock("../commitments/config.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../commitments/config.js")>()),
  resolveCommitmentsConfig: () => ({
    enabled: true,
    maxPerDay: 3,
    extraction: {
      debounceMs: 15_000,
      batchMaxItems: 8,
      queueMaxItems: 64,
      confidenceThreshold: 0.72,
      careConfidenceThreshold: 0.86,
      timeoutSeconds: 45,
    },
  }),
}));

installHeartbeatRunnerTestRuntime();

describe("heartbeat runner failure finalization", () => {
  const nowMs = Date.parse("2026-04-29T17:00:00.000Z");
  const envSnapshot = captureEnv(["OPENCLAW_STATE_DIR"]);

  afterEach(() => {
    closeOpenClawStateDatabaseForTest();
    setHeartbeatsEnabled(true);
    vi.unstubAllEnvs();
    envSnapshot.restore();
    resetHeartbeatEventsForTest();
    resetSystemEventsForTest();
  });

  it("keeps commitments and inspected events retryable after a delivered runner failure", async () => {
    await withTempHeartbeatSandbox(async ({ tmpDir, storePath, replySpy }) => {
      setTestEnvValue("OPENCLAW_STATE_DIR", tmpDir);
      const sessionKey = "agent:main:telegram:user-155462274";
      const cfg: OpenClawConfig = {
        agents: {
          defaults: {
            workspace: tmpDir,
            heartbeat: { every: "5m", target: "last" },
          },
        },
        channels: { telegram: { allowFrom: ["*"] } },
        session: { store: storePath },
      };
      await seedSessionStore(storePath, sessionKey, {
        lastChannel: "telegram",
        lastProvider: "telegram",
        lastTo: "155462274",
        // A legacy build may already have poisoned dedupe state with this copy.
        lastHeartbeatText: HEARTBEAT_EXTERNAL_RUN_FAILURE_TEXT,
        lastHeartbeatSentAt: nowMs - 1_000,
      });
      const commitment: CommitmentRecord = {
        id: "cm_interview",
        agentId: "main",
        sessionKey,
        channel: "telegram",
        accountId: "primary",
        to: "155462274",
        kind: "event_check_in",
        sensitivity: "routine",
        source: "inferred_user_context",
        status: "pending",
        reason: "The user said they had an interview yesterday.",
        suggestedText: "How did the interview go?",
        dedupeKey: "interview:2026-04-28",
        confidence: 0.92,
        dueWindow: {
          earliestMs: nowMs - 60_000,
          latestMs: nowMs + 60 * 60_000,
          timezone: "America/Los_Angeles",
        },
        createdAtMs: nowMs - 24 * 60 * 60_000,
        updatedAtMs: nowMs - 24 * 60 * 60_000,
        attempts: 0,
      };
      seedCommitmentsForTest([commitment]);
      enqueueSystemEvent("Cron: prepare the interview follow-up", {
        sessionKey,
        contextKey: "cron:interview-follow-up",
      });

      const sendTelegram = vi.fn().mockResolvedValue({
        messageId: "m1",
        chatId: "155462274",
      });
      replySpy
        .mockResolvedValueOnce({ text: GENERIC_EXTERNAL_RUN_FAILURE_TEXT })
        .mockResolvedValueOnce({ text: "How did the interview go?" });
      const runOnce = async () =>
        await runHeartbeatOnce({
          cfg,
          agentId: "main",
          sessionKey,
          deps: {
            getReplyFromConfig: replySpy,
            telegram: sendTelegram,
            getQueueSize: () => 0,
            nowMs: () => nowMs,
          },
        });

      await expect(runOnce()).resolves.toEqual({
        status: "failed",
        reason: "agent-runner-failure",
      });
      expect(sendTelegram).toHaveBeenNthCalledWith(
        1,
        "155462274",
        HEARTBEAT_EXTERNAL_RUN_FAILURE_TEXT,
        expect.any(Object),
      );
      let stored = readCommitmentsForTest()[0];
      expect(stored).toMatchObject({
        id: "cm_interview",
        status: "pending",
        attempts: 1,
        lastAttemptAtMs: nowMs,
      });
      expect(stored?.sentAtMs).toBeUndefined();
      expect(stored?.dismissedAtMs).toBeUndefined();
      expect(peekSystemEventEntries(sessionKey)).toHaveLength(1);
      const sessionAfterFailure = readSessionStoreForTest<{
        lastHeartbeatText?: string;
        lastHeartbeatSentAt?: number;
      }>(storePath)[sessionKey];
      expect(sessionAfterFailure?.lastHeartbeatText).toBe(HEARTBEAT_EXTERNAL_RUN_FAILURE_TEXT);
      expect(sessionAfterFailure?.lastHeartbeatSentAt).toBe(nowMs - 1_000);

      await expect(runOnce()).resolves.toMatchObject({ status: "ran" });
      expect(sendTelegram).toHaveBeenNthCalledWith(
        2,
        "155462274",
        "How did the interview go?",
        expect.any(Object),
      );
      stored = readCommitmentsForTest()[0];
      expect(stored).toMatchObject({
        id: "cm_interview",
        status: "sent",
        attempts: 2,
        sentAtMs: nowMs,
      });
      expect(peekSystemEventEntries(sessionKey)).toHaveLength(0);
    });
  });
});
