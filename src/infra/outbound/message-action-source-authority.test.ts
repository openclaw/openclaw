import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { afterEach, expect, it, vi } from "vitest";
import { observeHostDataSql } from "../../../test/helpers/sqlite-statement-execution-counter.js";
import { createSessionCompoundWorkerFixture } from "../../config/sessions/session-compound-worker.test-support.js";
import * as jobs from "../../cron/active-jobs.js";
import { prepareCronRunAdmission } from "../../cron/run-admission.js";
import { TEST_SCHEDULED_EXECUTION } from "../../cron/scheduled-occurrence.test-support.js";
import * as capability from "../../gateway/message-action-turn-capability.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import * as admission from "../sqlite-worker-operation-admission.js";
import { sqliteWorkerOwnerProbe as probe } from "../sqlite-worker-owner-probe.test-support.js";
import { runMessageAction } from "./message-action-runner.js";

afterEach(() => vi.restoreAllMocks());

it.each(["stale-attempt", "revoked-capability"] as const)(
  "refuses a scheduled source commit with %s authority",
  async (mode) =>
    withOpenClawTestState({ scenario: "minimal" }, async () => {
      const f = createSessionCompoundWorkerFixture();
      const jobId = "source-reply-job";
      const runId = "source-reply-run";
      const marker = jobs.markCronJobActive(jobId, { isMessageActionAuthorityCurrent: () => true });
      let current = true;
      const stale = new Error("delivery attempt is no longer current");
      const cfg = { session: { store: f.database.path } };
      const run = prepareCronRunAdmission({
        scheduledExecution: TEST_SCHEDULED_EXECUTION,
        ...f.scope,
        cfg,
        jobId,
        runId,
        scheduledToolPolicy: { version: 1, mode: "trusted" },
        toolsAllow: ["message"],
        deliveryAttemptFence: {
          async beforeAttempt() {},
          assertCurrent() {
            if (!current) {
              throw stale;
            }
          },
        },
      });
      try {
        const admitted = await run.preparedRunAdmission.admit("embedded");
        jobs.bindCronJobAdmittedRun(marker, admitted, new AbortController().signal);
        const authorization = capability.resolveMessageActionTurnAuthorization({
          ...f.scope,
          runId,
          token: run.messageActionTurnCapability,
        });
        expect(authorization?.scheduled).toBeDefined();
        const before = f.events();
        let reachedCommit = false;
        probe.admission(admission, (request, grant, admit) => {
          if (
            request.stage === "commit" &&
            isRecord(request.facts) &&
            isRecord(request.facts.publication) &&
            request.facts.publication.kind === "session-entry-patch-committed"
          ) {
            reachedCommit = true;
            if (mode === "stale-attempt") {
              current = false;
            } else if (mode === "revoked-capability") {
              capability.revokeMessageActionTurnCapability(run.messageActionTurnCapability);
            }
          }
          admit(request, grant);
        });
        const send = () =>
          runMessageAction({
            ...f.scope,
            cfg,
            runId,
            action: "send",
            params: { message: "Scheduled source reply", idempotencyKey: "source-reply" },
            toolContext: { currentChannelProvider: "webchat" },
            messageActionAuthorization: authorization,
            sourceReplyDeliveryMode: "message_tool_only",
          });
        const sql = observeHostDataSql();
        try {
          await expect(send()).rejects.toThrow(
            mode === "stale-attempt" ? stale : "message action turn capability is no longer active",
          );
          expect(reachedCommit).toBe(true);
          expect(sql.queries).toEqual([]);
        } finally {
          sql.restore();
        }
        expect(f.events()).toEqual(before);
      } finally {
        run.close();
        jobs.clearCronJobActive(jobId, marker);
      }
    }),
);
