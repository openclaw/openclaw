import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import {
  appendTranscriptMessage,
  loadTranscriptEvents,
} from "../../config/sessions/session-accessor.js";
import { closeOpenClawAgentDatabasesAsync } from "../../state/openclaw-agent-db.js";
import {
  initSessionState,
  readSessionStore as readSessionStoreFast,
  writeSessionStore as writeSessionStoreFast,
} from "./test/session.test-support.js";

const tempDirs = useAutoCleanupTempDirTracker((cleanup) =>
  afterEach(async () => {
    await closeOpenClawAgentDatabasesAsync();
    cleanup();
  }),
);

describe("terminal completion session reuse", () => {
  it.each(["failed", "timeout", "killed"] as const)(
    "recovers a %s completion before admitting a later channel source",
    async (status) => {
      const storePath = path.join(tempDirs.make("openclaw-terminal-completion-"), "sessions.json");
      const sessionKey = "agent:main:slack:fixture:direct:requester";
      const sessionId = "completion-session";
      const sourceRunId = "announce:child:succeeded";
      const harnessCompletion = {
        taskId: "child",
        taskRunId: "child",
        taskStatus: "succeeded" as const,
        sourceRunId,
        requesterSessionKey: sessionKey,
        requesterAgentId: "main",
        sessionId,
        lifecycleRevision: "completion-revision",
      };
      const deliveryContext = { channel: "slack", to: "D123", accountId: "fixture" };
      await writeSessionStoreFast(storePath, {
        [sessionKey]: {
          sessionId,
          lifecycleRevision: harnessCompletion.lifecycleRevision,
          updatedAt: Date.now(),
          status,
          abortedLastRun: true,
          restartRecoveryDeliveryRunId: sourceRunId,
          restartRecoveryDeliverySourceRunId: sourceRunId,
          restartRecoverySourceIngress: "internal",
          restartRecoveryDeliveryContext: deliveryContext,
          restartRecoveryHarnessCompletion: harnessCompletion,
        },
      });
      await appendTranscriptMessage(
        { agentId: "main", storePath, sessionKey, sessionId },
        {
          eventId: "completion-input",
          message: {
            role: "user",
            content: "The child task completed.",
            idempotencyKey: `${sourceRunId}:user`,
            provenance: {
              kind: "inter_session",
              sourceChannel: "internal",
              sourceTool: "agent_harness_completion",
              sourceSessionKey: "child",
            },
            __openclaw: { runId: sourceRunId },
          },
        },
      );
      const transcriptBefore = await loadTranscriptEvents({
        agentId: "main",
        storePath,
        sessionId,
      });
      const result = await initSessionState({
        cfg: { session: { store: storePath } },
        ctx: { Body: "Are you there?", SessionKey: sessionKey, Provider: "slack" },
      });
      const entry = readSessionStoreFast(storePath)[sessionKey];
      expect(result.isNewSession).toBe(false);
      expect(result.abortedLastRun).toBe(true);
      expect(entry?.status).toBe(status);
      expect(entry).toMatchObject({
        sessionId,
        lifecycleRevision: harnessCompletion.lifecycleRevision,
        abortedLastRun: true,
        restartRecoveryDeliveryRunId: sourceRunId,
        restartRecoveryDeliverySourceRunId: sourceRunId,
        restartRecoverySourceIngress: "internal",
        restartRecoveryDeliveryContext: deliveryContext,
        restartRecoveryHarnessCompletion: harnessCompletion,
      });
      expect(await loadTranscriptEvents({ agentId: "main", storePath, sessionId })).toEqual(
        transcriptBefore,
      );
    },
  );
});
