import { randomUUID } from "node:crypto";
import fs from "node:fs";
import { setTimeout as delay } from "node:timers/promises";
import { expectDefined } from "@openclaw/normalization-core/expect";
import { Client } from "pg";
import { describe, expect, it, vi } from "vitest";
import { ErrorCodes } from "../../../packages/gateway-protocol/src/index.js";
import { withinTest } from "../../../test/helpers/promise.js";
import {
  appendTranscriptEvent,
  replaceSessionEntry,
} from "../../config/sessions/session-accessor.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { normalizeCronRunErrorText } from "../../cron/service/execution-errors.js";
import {
  respondChatSendAdmissionError,
  resolveChatSendStorageErrorMessage,
} from "../../gateway/server-methods/chat-send-admission-errors.js";
import type { RespondFn } from "../../gateway/server-methods/types.js";
import { openOpenClawAgentDatabase } from "../../state/openclaw-agent-db.js";
import { cleanupSessionStateForTest } from "../../test-utils/session-state-cleanup.js";
import { classifyGatewayStorageFailure } from "../sqlite-error-diagnostics.js";
import { hasSqliteWorkerOutcomeUnknown } from "../sqlite-worker-contract.js";
import { withEngineStoreAdmission } from "./admission-scope.js";
import { mixedAgentConnection, useMixedAgentPair } from "./mixed-agent.conformance.test-support.js";

describe.skipIf(!mixedAgentConnection)("PostgreSQL failures at the chat and cron surfaces", () => {
  const pair = useMixedAgentPair("sqlite", "postgres");

  it.for(["terminate", "cancel"] as const)(
    "preserves the %s outcome from the transcript worker through client rendering",
    { timeout: 60_000 },
    async (fault, { signal }) => {
      const database = withEngineStoreAdmission(() =>
        openOpenClawAgentDatabase({ agentId: "main" }),
      );
      const scope = {
        agentId: "main",
        storePath: database.path,
        sessionKey: `agent:main:postgres-${fault}-${randomUUID()}`,
        sessionId: randomUUID(),
      };
      await replaceSessionEntry(scope, { sessionId: scope.sessionId, updatedAt: Date.now() });
      await appendTranscriptEvent(scope, { type: "session", version: 3, id: scope.sessionId });
      const config = JSON.parse(
        fs.readFileSync(process.env.OPENCLAW_CONFIG_PATH!, "utf8"),
      ) as OpenClawConfig;
      const admin = new Client({ connectionString: mixedAgentConnection });
      const locker = new Client({ connectionString: mixedAgentConnection });
      let write: Promise<PromiseSettledResult<boolean>> | undefined;
      try {
        await Promise.all([admin.connect(), locker.connect()]);
        const prefix = config.database!.postgres!.schemaPrefix!;
        const schemas = await admin.query<{ table_schema: string }>(
          "SELECT table_schema FROM information_schema.tables WHERE left(table_schema, $1) = $2 AND table_name = 'transcript_events'",
          [prefix.length + 7, `${prefix}_agent_`],
        );
        expect(schemas.rows).toHaveLength(1);
        const table = `"${schemas.rows[0]!.table_schema.replaceAll('"', '""')}".transcript_events`;
        await locker.query("BEGIN");
        await locker.query(`LOCK TABLE ${table} IN SHARE MODE`);
        const lockerPid = (await locker.query<{ pid: number }>("SELECT pg_backend_pid() AS pid"))
          .rows[0]!.pid;
        write = appendTranscriptEvent(scope, {
          type: "custom",
          id: randomUUID(),
          customType: "outcome-proof",
          data: { fault },
        }).then(
          (value) => ({ status: "fulfilled", value }),
          (reason: unknown) => ({ status: "rejected", reason }),
        );
        let blockedPid: number | undefined;
        const deadline = Date.now() + 15_000;
        while (!blockedPid && Date.now() < deadline) {
          const result = await admin.query<{ pid: number }>(
            "SELECT a.pid FROM pg_stat_activity a JOIN pg_locks l ON l.pid = a.pid WHERE a.state = 'active' AND a.query ILIKE '%INSERT INTO%' AND NOT l.granted AND l.relation = $1::regclass AND $2 = ANY(pg_blocking_pids(a.pid))",
            [table, lockerPid],
          );
          blockedPid = result.rows[0]?.pid;
          if (!blockedPid) {
            await delay(20);
          }
        }
        expect(blockedPid, "transcript worker reached its PostgreSQL write").toBeDefined();
        const injected = await admin.query<{ injected: boolean }>(
          fault === "terminate"
            ? "SELECT pg_terminate_backend($1) AS injected"
            : "SELECT pg_cancel_backend($1) AS injected",
          [blockedPid],
        );
        expect(injected.rows[0]?.injected).toBe(true);
        await locker.query("ROLLBACK");
        const outcome = await withinTest(write, signal);
        expect(outcome.status).toBe("rejected");
        if (outcome.status !== "rejected") {
          throw new Error("Expected the native write to fail");
        }
        const failure: unknown = outcome.reason;
        const code = fault === "terminate" ? "session_actor_reconciliation" : "57014";
        expect(hasSqliteWorkerOutcomeUnknown(failure)).toBe(fault === "terminate");
        expect(classifyGatewayStorageFailure(failure)).toBe(code);

        const respond = vi.fn<RespondFn>();
        const onStorageError = vi.fn<(message: string) => void>();
        respondChatSendAdmissionError(failure, respond, onStorageError);
        expect(respond).toHaveBeenCalledWith(
          false,
          undefined,
          expect.objectContaining({
            code: ErrorCodes.UNAVAILABLE,
            retryable: false,
            details: { code },
          }),
        );
        const response = expectDefined(respond.mock.calls[0]?.[2], "chat error response");
        for (const rendered of [
          response.message,
          resolveChatSendStorageErrorMessage(failure),
          onStorageError.mock.calls[0]?.[0],
          normalizeCronRunErrorText(failure),
        ]) {
          expect(rendered).toMatch(/check|reopen|retry/i);
          expect(rendered).toMatch(fault === "terminate" ? /confirm|saved/i : /cancel|timeout/i);
        }
        expect(
          await appendTranscriptEvent(scope, {
            type: "custom",
            id: randomUUID(),
            customType: "recovered-write",
            data: {},
          }),
        ).toBe(true);
      } finally {
        await locker.query("ROLLBACK").catch(() => {});
        if (write) {
          await write;
        }
        await Promise.all([admin.end(), locker.end()]);
        await cleanupSessionStateForTest({ stateDir: pair.root });
      }
    },
  );
});
