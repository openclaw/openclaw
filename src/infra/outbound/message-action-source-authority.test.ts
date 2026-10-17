import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { afterEach, expect, it, vi } from "vitest";
import { observeHostDataSql } from "../../../test/helpers/sqlite-statement-execution-counter.js";
import { createSessionCompoundWorkerFixture } from "../../config/sessions/session-compound-worker.test-support.js";
import {
  bindCronJobAdmittedRun,
  clearCronJobActive,
  markCronJobActive,
} from "../../cron/active-jobs.js";
import { prepareCronRunAdmission } from "../../cron/run-admission.js";
import {
  resolveMessageActionTurnAuthorization,
  revokeMessageActionTurnCapability,
} from "../../gateway/message-action-turn-capability.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import * as admission from "../sqlite-worker-operation-admission.js";
import { sqliteWorkerOwnerProbe as probe } from "../sqlite-worker-owner-probe.test-support.js";
import { runMessageAction } from "./message-action-runner.js";

afterEach(() => vi.restoreAllMocks());

it.each(["current", "stale-attempt", "revoked-capability"] as const)(
  "commits a scheduled source reply through the worker with %s authority",
  async (mode) => {
    await withOpenClawTestState({ scenario: "minimal" }, async () => {
      const f = createSessionCompoundWorkerFixture();
      const jobId = "source-reply-job";
      const runId = "source-reply-run";
      const marker = markCronJobActive(jobId, { isMessageActionAuthorityCurrent: () => true });
      let current = true;
      let atCommit = false;
      let commitChecks = 0;
      const stale = new Error("delivery attempt is no longer current");
      const cfg = { session: { store: f.database.path } };
      const run = prepareCronRunAdmission({
        ...f.scope,
        cfg,
        jobId,
        runId,
        scheduledToolPolicy: { version: 1, mode: "trusted" },
        toolsAllow: ["message"],
        deliveryAttemptFence: {
          async beforeAttempt() {},
          assertCurrent() {
            if (atCommit) {
              commitChecks++;
            }
            if (!current) {
              throw stale;
            }
          },
        },
      });
      try {
        const admitted = await run.preparedRunAdmission.admit("embedded");
        bindCronJobAdmittedRun(marker, admitted, new AbortController().signal);
        const authorization = resolveMessageActionTurnAuthorization({
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
              revokeMessageActionTurnCapability(run.messageActionTurnCapability);
            }
          }
          atCommit = request.stage === "commit" && reachedCommit;
          try {
            admit(request, grant);
          } finally {
            atCommit = false;
          }
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
          if (mode === "current") {
            await expect(send()).resolves.toMatchObject({ handledBy: "internal-source" });
          } else {
            await expect(send()).rejects.toThrow(
              mode === "stale-attempt"
                ? stale
                : "message action turn capability is no longer active",
            );
          }
          expect(reachedCommit).toBe(true);
          expect(commitChecks).toBe(mode === "revoked-capability" ? 0 : 1);
          expect(sql.queries).toEqual([]);
        } finally {
          sql.restore();
        }
        const events = f.events();
        if (mode === "current") {
          expect(events).toEqual(
            expect.arrayContaining([
              expect.objectContaining({
                type: "message",
                message: expect.objectContaining({
                  role: "assistant",
                  content: [{ type: "text", text: "Scheduled source reply" }],
                }),
              }),
            ]),
          );
          await send();
          expect(f.events()).toEqual(events);
        } else {
          expect(events).toEqual(before);
        }
      } finally {
        run.close();
        clearCronJobActive(jobId, marker);
      }
    });
  },
);
