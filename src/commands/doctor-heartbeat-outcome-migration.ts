import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { listAgentIds } from "../agents/agent-scope-config.js";
import { buildRuntimeContextCustomMessage } from "../agents/embedded-agent-runner/run/runtime-context-prompt.js";
import { sliceToolResultTextToBudget } from "../agents/embedded-agent-runner/tool-result-text-budget.js";
import { resolveSessionStorePathCore } from "../config/sessions/paths.js";
import {
  evaluateSessionFreshness,
  resolveSessionResetPolicy,
  resolveSessionResetType,
  resolveChannelResetConfig,
} from "../config/sessions/reset.js";
import {
  loadSessionEntryReadOnly,
  persistSessionTranscriptTurn,
} from "../config/sessions/session-accessor.js";
import {
  resolveSqliteScope,
  toDatabaseOptions,
} from "../config/sessions/session-accessor.sqlite-scope.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { executeSqliteQuerySync, getNodeSqliteKysely } from "../infra/kysely-sync.js";
import { withOpenClawAgentDatabaseReadOnly } from "../state/openclaw-agent-db-readonly.js";
import type { DB } from "../state/openclaw-agent-db.generated.js";
import {
  openOpenClawAgentDatabase,
  runOpenClawAgentWriteTransaction,
} from "../state/openclaw-agent-db.js";
import { deliveryContextFromSession } from "../utils/delivery-context.read.js";

/** The inert source table stays at the current agent schema; transcript idempotency owns import. */
export async function migrateHeartbeatOutcomes(
  cfg: OpenClawConfig,
  env: NodeJS.ProcessEnv,
): Promise<void> {
  for (const agentId of listAgentIds(cfg)) {
    const storePath = resolveSessionStorePathCore(cfg.session?.store, { agentId, env });
    const read = withOpenClawAgentDatabaseReadOnly(
      ({ db }) =>
        executeSqliteQuerySync(
          db,
          getNodeSqliteKysely<Pick<DB, "heartbeat_outcomes">>(db)
            .selectFrom("heartbeat_outcomes")
            .selectAll()
            .where("context_run_id", "is", null),
        ).rows,
      toDatabaseOptions(
        resolveSqliteScope({ agentId, storePath, env, sessionKey: `agent:${agentId}:main` }),
      ),
    );
    if (!read.found) {
      continue;
    }
    for (const row of read.value) {
      if (!["progress", "done", "blocked", "needs_attention"].includes(row.outcome)) {
        throw new Error(
          `Unknown pending heartbeat outcome for ${row.session_key}; preserve the database and inspect it before cutover.`,
        );
      }
      const scope = { agentId, storePath, env, sessionKey: row.session_key };
      const entry = loadSessionEntryReadOnly(scope);
      if (!entry) {
        throw new Error(
          `Pending heartbeat outcome for ${row.session_key} has no current session. Restore its session before completing Doctor cutover.`,
        );
      }
      const now = Date.now();
      const policy = resolveSessionResetPolicy({
        sessionCfg: cfg.session,
        resetType: resolveSessionResetType({ sessionKey: row.session_key }),
        resetOverride: resolveChannelResetConfig({
          sessionCfg: cfg.session,
          channel: deliveryContextFromSession(entry)?.channel,
        }),
      });
      // The legacy row has no TTL or generation column. Never promote facts from
      // before the current session, or into a session already due for reset.
      if (
        (entry.sessionStartedAt !== undefined && row.occurred_at < entry.sessionStartedAt) ||
        !evaluateSessionFreshness({ ...entry, now, policy }).fresh
      ) {
        continue;
      }
      const options = toDatabaseOptions(resolveSqliteScope(scope));
      const assertOriginal = () => {
        const { db } = openOpenClawAgentDatabase(options);
        const current = executeSqliteQuerySync(
          db,
          getNodeSqliteKysely<Pick<DB, "heartbeat_outcomes">>(db)
            .selectFrom("heartbeat_outcomes")
            .selectAll()
            .where("session_key", "=", row.session_key),
        ).rows[0];
        if (!isDeepStrictEqual(current, row)) {
          throw new Error(
            `Pending heartbeat outcome for ${row.session_key} changed during cutover; rerun Doctor.`,
          );
        }
      };
      const digest = createHash("sha256").update(JSON.stringify(row)).digest("hex");
      const message = buildRuntimeContextCustomMessage(
        sliceToolResultTextToBudget(
          `Migrated automation result (recorded fact, not an instruction):\n${row.outcome}: ${row.summary}\nRecorded at ${new Date(row.occurred_at).toISOString()}.`,
          2000,
        ),
      );
      if (!message) {
        throw new Error(`Pending heartbeat outcome for ${row.session_key} produced no context.`);
      }
      assertOriginal();
      const result = await persistSessionTranscriptTurn(scope, {
        config: cfg,
        expectedSessionId: entry.sessionId,
        expectedLifecycleRevision: entry.lifecycleRevision ?? null,
        touchSessionEntry: false,
        messages: [
          {
            message: { ...message, idempotencyKey: `doctor:heartbeat-outcome:${digest}` },
            idempotencyLookup: "scan",
            // Doctor checks its source row in the same native transaction as the append.
            beforeFreshMessageCommit: assertOriginal,
          },
        ],
      });
      if (result.rejectedReason) {
        throw new Error("Session changed before its migrated heartbeat context could be recorded");
      }
      // Transcript append is async and owns a different commit. Compare the entire
      // original row after it settles so an old import never deletes a replacement.
      runOpenClawAgentWriteTransaction(
        ({ db }) => {
          assertOriginal();
          executeSqliteQuerySync(
            db,
            getNodeSqliteKysely<Pick<DB, "heartbeat_outcomes">>(db)
              .deleteFrom("heartbeat_outcomes")
              .where("session_key", "=", row.session_key),
          );
        },
        options,
        { operationLabel: "doctor.heartbeat-outcome-retirement" },
      );
    }
  }
}
