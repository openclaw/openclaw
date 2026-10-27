import { describe, expect, it } from "vitest";
import { listAuditEvents } from "../../audit/audit-event-store.js";
import { readAllClawCronRefsInDatabase } from "../../claws/cron-records.js";
import { writeRepairJournal } from "../../commands/doctor-session-incognito-key-repair-state.js";
import { repairReservedIncognitoSessionKeys } from "../../commands/doctor-session-incognito-key-repair.js";
import { sessionSqlFixture } from "../../commands/doctor-session-sqlite.sql.test-support.js";
import {
  openOpenClawStateDatabase,
  runOpenClawStateWriteTransaction,
} from "../../state/openclaw-state-db.js";
import { captureOpenClawStateWorkerContext } from "../../state/openclaw-state-worker-context.js";
import { executeOpenClawStateWorker } from "../../state/openclaw-state-worker-store.js";
import { installDatabaseProcessRole, withEngineStoreAdmission } from "./admission-scope.js";
import { mixedAgentConnection, useMixedAgentPair } from "./mixed-agent.conformance.test-support.js";

describe.skipIf(!mixedAgentConnection).each(["sqlite", "postgres"] as const)(
  "%s admitted schema readers",
  (engine) => {
    useMixedAgentPair(engine, "sqlite");

    it("persists first-use message pseudonyms through the audit worker", async () => {
      const context = captureOpenClawStateWorkerContext({});
      await expect(
        executeOpenClawStateWorker(context, {
          type: "audit.writer.process",
          input: [
            {
              type: "record-event",
              eventId: "first-message",
              input: {
                sourceId: "first-message",
                sourceSequence: 1,
                occurredAt: Date.now(),
                kind: "message",
                action: "message.inbound.processed",
                direction: "inbound",
                status: "succeeded",
                outcome: "completed",
                actorType: "channel_sender",
                actorId: "synthetic-sender",
                channel: "synthetic",
                conversationKind: "direct",
                accountId: "synthetic-account",
                conversationId: "synthetic-conversation",
                messageId: "synthetic-message",
              },
            },
          ],
        }),
      ).resolves.toEqual([{ status: "settled" }]);
      const { events } = await listAuditEvents({ limit: 10, filters: { includeMessages: true } });
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({
        eventId: "first-message",
        actorId: expect.stringMatching(/^hmac-sha256:v1:/u),
        accountRef: expect.stringMatching(/^hmac-sha256:v1:/u),
        messageRef: expect.stringMatching(/^hmac-sha256:v1:/u),
      });
    });

    it("returns persisted Claw cron ownership from its admitted store", () => {
      const job = {
        id: "synthetic-job",
        schedule: { cron: "0 8 * * *" },
        message: "Synthetic reminder",
        session: "main",
      };
      withEngineStoreAdmission(() =>
        runOpenClawStateWriteTransaction(({ db }) => {
          sessionSqlFixture(db)`INSERT INTO claw_cron_refs
            (agent_id, manifest_id, declaration_key, schema_version, scheduler_job_id, status, job_json, error, created_at_ms, updated_at_ms)
            VALUES ('main', 'synthetic-claw', 'synthetic-declaration', 'openclaw.clawCronRef.v1', 'synthetic-scheduler', 'complete', ${JSON.stringify(job)}, NULL, 10, 20)`.run();
        }),
      );
      expect(
        withEngineStoreAdmission(() =>
          readAllClawCronRefsInDatabase(openOpenClawStateDatabase().db),
        ),
      ).toMatchObject([
        {
          agentId: "main",
          manifestId: "synthetic-claw",
          declarationKey: "synthetic-declaration",
          schedulerJobId: "synthetic-scheduler",
          status: "complete",
          job,
          createdAtMs: 10,
          updatedAtMs: 20,
        },
      ]);
    });

    it("resumes Doctor's journal and rewrites scalar and JSON shared-state keys", async () => {
      const oldKey = "agent:main:dashboard:incognito-synthetic";
      const newKey = "agent:main:dashboard:legacy-incognito-synthetic";
      withEngineStoreAdmission(() =>
        runOpenClawStateWriteTransaction((database) => {
          writeRepairJournal(database.db, [{ from: oldKey, to: newKey }]);
          sessionSqlFixture(database.db)`INSERT INTO operator_approvals
            (cursor_id, approval_id, resolution_ref, kind, status, presentation_json, reviewer_device_ids_json,
             source_session_key, audience_session_keys_json, runtime_epoch, created_at_ms, expires_at_ms, updated_at_ms)
            VALUES (1, 'synthetic-approval', ${"a".repeat(43)}, 'exec', 'pending', '{}', '[]',
              ${oldKey}, ${JSON.stringify([oldKey, "unchanged-key"])}, 'synthetic-epoch', 1, 2, 1)`.run();
        }),
      );
      installDatabaseProcessRole("cli-oneshot");
      await expect(
        repairReservedIncognitoSessionKeys({
          apply: true,
          cfg: {},
          env: { ...process.env },
          targets: [],
        }),
      ).resolves.toEqual({ found: 1, repaired: 1 });
      const row = withEngineStoreAdmission(() =>
        runOpenClawStateWriteTransaction(({ db }) =>
          sessionSqlFixture(db)`SELECT source_session_key, audience_session_keys_json
            FROM operator_approvals WHERE approval_id = 'synthetic-approval'`.get(),
        ),
      );
      expect(row).toEqual({
        source_session_key: newKey,
        audience_session_keys_json: JSON.stringify([newKey, "unchanged-key"]),
      });
    });
  },
);
