import { describe, expect, it } from "vitest";
import { listAuditEvents } from "../../audit/audit-event-store.js";
import { readAllClawCronRefsInDatabase } from "../../claws/cron-records.js";
import { writeRepairJournal } from "../../commands/doctor-session-incognito-key-repair-state.js";
import { repairReservedIncognitoSessionKeys } from "../../commands/doctor-session-incognito-key-repair.js";
import type { DB } from "../../state/openclaw-state-db.generated.js";
import {
  openOpenClawStateDatabase,
  runOpenClawStateWriteTransaction,
} from "../../state/openclaw-state-db.js";
import { captureOpenClawStateWorkerContext } from "../../state/openclaw-state-worker-context.js";
import { executeOpenClawStateWorker } from "../../state/openclaw-state-worker-store.js";
import { executeSqliteQuerySync, getNodeSqliteKysely } from "../kysely-sync.js";
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
          executeSqliteQuerySync(
            db,
            getNodeSqliteKysely<DB>(db)
              .insertInto("claw_cron_refs")
              .values({
                agent_id: "main",
                manifest_id: "synthetic-claw",
                declaration_key: "synthetic-declaration",
                schema_version: "openclaw.clawCronRef.v1",
                scheduler_job_id: "synthetic-scheduler",
                status: "complete",
                job_json: JSON.stringify(job),
                error: null,
                created_at_ms: 10,
                updated_at_ms: 20,
              }),
          );
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
          const db = getNodeSqliteKysely<DB>(database.db);
          executeSqliteQuerySync(
            database.db,
            db.insertInto("operator_approvals").values({
              cursor_id: 1,
              approval_id: "synthetic-approval",
              resolution_ref: "a".repeat(43),
              kind: "exec",
              status: "pending",
              presentation_json: "{}",
              reviewer_device_ids_json: "[]",
              source_session_key: oldKey,
              audience_session_keys_json: JSON.stringify([oldKey, "unchanged-key"]),
              runtime_epoch: "synthetic-epoch",
              created_at_ms: 1,
              expires_at_ms: 2,
              updated_at_ms: 1,
            }),
          );
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
        runOpenClawStateWriteTransaction(
          ({ db }) =>
            executeSqliteQuerySync(
              db,
              getNodeSqliteKysely<DB>(db)
                .selectFrom("operator_approvals")
                .select(["source_session_key", "audience_session_keys_json"])
                .where("approval_id", "=", "synthetic-approval"),
            ).rows[0],
        ),
      );
      expect(row).toEqual({
        source_session_key: newKey,
        audience_session_keys_json: JSON.stringify([newKey, "unchanged-key"]),
      });
    });
  },
);
