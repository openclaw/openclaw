import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { scanDoctorSessionEntryRecords } from "../../commands/doctor/shared/session-entry-rewrite.js";
import { captureRuntimeConfigAsyncReader } from "../../config/io.runtime.js";
import { loadSessionEntryReadOnly } from "../../config/sessions/session-accessor.js";
import { upsertSessionEntryCore } from "../../config/sessions/session-accessor.sqlite-entry.js";
import { markCanonicalSessionValidationPending } from "../../config/sessions/session-canonical-key.js";
import { prepareGatewayStartupSessions } from "../../gateway/server-startup-session-migration.js";
import { readDatabasePathIdentitySync } from "../../infra/sqlite-worker-identity.js";
import { closeOpenClawAgentDatabases } from "../../state/openclaw-agent-db-lifecycle.js";
import { openOpenClawAgentDatabase } from "../../state/openclaw-agent-db.js";
import { cleanupSessionStateForTest } from "../../test-utils/session-state-cleanup.js";
import { withEngineStoreAdmission } from "./admission-scope.js";
import {
  mixedAgentConnection,
  mixedAgentPairs,
  useMixedAgentPair,
} from "./mixed-agent.conformance.test-support.js";

describe
  .skipIf(!mixedAgentConnection)
  .each(mixedAgentPairs.filter(({ stateEngine, agentEngine }) => stateEngine === agentEngine))(
  "$agentEngine Gateway session startup",
  ({ stateEngine, agentEngine }) => {
    const pair = useMixedAgentPair(stateEngine, agentEngine);

    it.each(["main", "qa"])(
      "admits fresh %s then repairs and retains its sessions across restart",
      async (agentId) => {
        const stateDir = path.join(pair.root, agentId);
        vi.stubEnv("OPENCLAW_STATE_DIR", stateDir);
        await captureRuntimeConfigAsyncReader()();
        const env = { ...process.env };
        const cfg = {
          agents: {
            ...(agentId === "main" ? { ownership: "explicit" as const } : {}),
            entries: { [agentId]: {} },
          },
        };
        withEngineStoreAdmission(() => {
          openOpenClawAgentDatabase({ agentId, env });
          closeOpenClawAgentDatabases(stateDir);
        });
        await cleanupSessionStateForTest({ stateDir });
        const freshLog = { info: vi.fn(), warn: vi.fn() };
        const fresh = await prepareGatewayStartupSessions({ cfg, env, log: freshLog });
        expect(fresh.map(({ database }) => database.agentId)).toEqual([agentId]);
        fresh[0]?.assertCurrent();
        expect(freshLog.warn).not.toHaveBeenCalled();
        withEngineStoreAdmission(() => closeOpenClawAgentDatabases(stateDir));
        await cleanupSessionStateForTest({ stateDir });
        const scope = { agentId, env, sessionKey: `agent:${agentId}:main` };
        const legacyScope = { ...scope, sessionKey: `agent:${agentId}:dashboard:running` };
        await upsertSessionEntryCore(scope, {
          sessionId: "retained-startup-session",
          updatedAt: 1,
        });
        const legacy = await upsertSessionEntryCore(legacyScope, {
          sessionId: "retained-running-session",
          status: "done",
        });
        const legacyJson = JSON.stringify({ ...legacy, status: "running" });
        withEngineStoreAdmission(() => {
          const database = openOpenClawAgentDatabase({ agentId, env });
          database.db
            .prepare("UPDATE session_nodes SET entry_json = ? WHERE session_key = ?")
            .run(`${legacyJson.slice(0, -1)},"opaque":9007199254740993}`, legacyScope.sessionKey);
          // Legacy repair clears its own row; retain normal work for the pooled validator.
          markCanonicalSessionValidationPending(database, [
            scope.sessionKey,
            legacyScope.sessionKey,
          ]);
        });
        withEngineStoreAdmission(() => closeOpenClawAgentDatabases(stateDir));
        await cleanupSessionStateForTest({ stateDir });

        for (let boot = 0; boot < 2; boot++) {
          const log = { info: vi.fn(), warn: vi.fn() };
          const databases = await prepareGatewayStartupSessions({ cfg, env, log });
          expect(databases).toHaveLength(1);
          expect(databases[0]?.database.agentId).toBe(agentId);
          databases[0]?.assertCurrent();
          expect(log.warn).not.toHaveBeenCalled();
          expect(withEngineStoreAdmission(() => loadSessionEntryReadOnly(scope))).toMatchObject({
            sessionId: "retained-startup-session",
          });
          expect(
            withEngineStoreAdmission(() => loadSessionEntryReadOnly(legacyScope)),
          ).toMatchObject({
            sessionId: "retained-running-session",
            status: "interrupted",
            abortedLastRun: true,
          });
          withEngineStoreAdmission(() => {
            const database = openOpenClawAgentDatabase({ agentId, env });
            expect(
              database.db
                .prepare("SELECT entry_json FROM session_nodes WHERE session_key = ?")
                .get(legacyScope.sessionKey)?.entry_json,
            ).toMatch(/"opaque"\s*:\s*9007199254740993/);
            expect(
              database.db
                .prepare("SELECT session_key FROM session_canonical_validation_pending")
                .all(),
            ).toEqual([]);
          });
          withEngineStoreAdmission(() => closeOpenClawAgentDatabases(stateDir));
          await cleanupSessionStateForTest({ stateDir });
        }
      },
    );

    it("filters legacy JSON without losing duplicate-key precedence or rejecting scalar rows", () => {
      withEngineStoreAdmission(() => {
        const env = { ...process.env, OPENCLAW_STATE_DIR: pair.root };
        const database = openOpenClawAgentDatabase({ agentId: "scan-proof", env });
        const insert = database.db.prepare(
          "INSERT INTO session_nodes (session_key, current_session_id, entry_json, updated_at) VALUES (?, ?, ?, 1)",
        );
        for (const [key, json] of [
          ["clean", '{"status":"done"}'],
          ["invalid", "{"],
          ["scalar", '"running"'],
          ["array", '["running"]'],
          ["duplicate", '{"status":"running","status":"done"}'],
          ["running", '{"status":"running"}'],
          ["boolean", '{"pendingFinalDelivery":true}'],
          ["string", '{"pendingFinalDelivery":"true"}'],
        ] as const) {
          insert.run(key, key, json);
        }
        const selected: Array<{ sessionKey: string; entry: Record<string, unknown> }> = [];
        scanDoctorSessionEntryRecords(
          { agentId: "scan-proof", storePath: database.path, env },
          (record) => selected.push(record),
          readDatabasePathIdentitySync(database.path),
        );
        expect(
          selected.toSorted((left, right) => left.sessionKey.localeCompare(right.sessionKey)),
        ).toEqual([
          { sessionKey: "boolean", entry: { pendingFinalDelivery: true } },
          { sessionKey: "duplicate", entry: { status: "done" } },
          { sessionKey: "running", entry: { status: "running" } },
        ]);
      });
    });
  },
);
