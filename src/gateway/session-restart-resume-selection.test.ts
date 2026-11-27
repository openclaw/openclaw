import { expect, it } from "vitest";
import { createOperationalRunInstanceRef } from "../agents/operational-run-instance.js";
import { createQueueTestRun } from "../auto-reply/reply/queue.test-helpers.js";
import { resolveSessionStorePathCore } from "../config/sessions/paths.js";
import { loadExactSessionEntry } from "../config/sessions/session-accessor.js";
import { replaceSessionEntrySync } from "../config/sessions/session-accessor.sqlite-entry.js";
import { makeCronJob } from "../cron/delivery.test-helpers.js";
import { TEST_SCHEDULED_TURN } from "../cron/scheduled-occurrence.test-support.js";
import {
  claimAgentRunContext,
  getAgentRunContext,
  releaseAgentRunContext,
} from "../infra/agent-run-registry.js";
import { attachSessionControllerInputOperation } from "../sessions/session-controller.mailbox-claim.js";
import {
  bindSessionControllerSource,
  releaseSessionControllerClaim,
  reserveSessionControllerSource,
} from "../sessions/session-controller.mailbox.js";
import { createReplyOperation } from "../sessions/session-controller.operation.js";
import { captureSessionTarget } from "../sessions/session-controller.target.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { persistRunningSessionsForRestart } from "./session-restart-resume.js";

it("preserves accepted user work while an automation backend is detached between attempts", () =>
  withOpenClawTestState({ scenario: "minimal" }, async () => {
    const scope = {
      agentId: "main",
      sessionKey: "agent:main:steered-cron",
      sessionId: "steered-cron",
    };
    replaceSessionEntrySync(scope, { sessionId: scope.sessionId, updatedAt: 1 });
    const target = captureSessionTarget({
      ...scope,
      incarnation: scope.sessionId,
      storeScope: resolveSessionStorePathCore(undefined, { agentId: scope.agentId }),
    });
    const operation = createReplyOperation({ ...scope, target, resetTriggered: false });
    const source = createQueueTestRun(
      { prompt: "Scheduled work" },
      {
        ...scope,
        scheduledAutomation: { ...TEST_SCHEDULED_TURN, job: makeCronJob({}) },
      },
    );
    const input = reserveSessionControllerSource(scope.sessionKey, {
      target,
      policy: { mode: "followup" },
    });
    bindSessionControllerSource(input, source);
    attachSessionControllerInputOperation(source, operation);
    const runId = "steered-cron-attempt";
    const claim = claimAgentRunContext(
      runId,
      {
        ...scope,
        cronRunsByJobId: new Map([
          [source.run.scheduledAutomation!.job.id, { nextCheckEnabled: false }],
        ]),
      },
      { trackOwner: true, ownsContext: true },
    );
    const backend = { kind: "embedded" as const, runId, cancel() {} };
    try {
      operation.attachBackend(backend);
      const run = getAgentRunContext(runId);
      expect(run).toBeDefined();
      run!.acceptedUserReply = {
        operationalRunInstance: createOperationalRunInstanceRef(runId),
        expectation: "required",
      };
      operation.detachBackend(backend);
      await persistRunningSessionsForRestart({ cfg: {} });
      expect(loadExactSessionEntry(scope)?.entry.resumeAfterRestart).toBeDefined();
    } finally {
      operation.complete();
      releaseSessionControllerClaim(input.claim!);
      await input.claim!.settlement.promise;
      releaseAgentRunContext(runId, claim);
    }
  }));
