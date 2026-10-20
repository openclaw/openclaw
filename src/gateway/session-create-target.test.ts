import { expect, it } from "vitest";
import { withinTest } from "../../test/helpers/promise.js";
import { observeHostDataSql } from "../../test/helpers/sqlite-statement-execution-counter.js";
import { replaceSessionEntrySync } from "../config/sessions/session-accessor.sqlite-entry.js";
import { prepareSessionEntryReplacementDatabase } from "../config/sessions/session-accessor.sqlite-replacement-worker.js";
import { createDeferredCore } from "../shared/deferred.js";
import {
  openOpenClawAgentDatabase,
  resolveOpenClawAgentSqlitePath,
} from "../state/openclaw-agent-db.js";
import { captureOpenClawAgentDatabaseExecution } from "../state/openclaw-agent-execution.js";
import { runOpenClawAgentWriteAdmission } from "../state/openclaw-agent-write-admission.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { normalizeSessionDeliveryState } from "../utils/delivery-context.shared.js";
import { readSessionCreateTarget } from "./session-create-target.js";
import { resolveGatewaySessionStoreTargetInWorker } from "./session-utils-store-worker.js";

const params = { cfg: {}, commandSource: "test", operatorRoleActor: { kind: "system" as const } };
function seed(env: NodeJS.ProcessEnv, sessionKey: string) {
  const scope = { agentId: "main", sessionKey, env };
  replaceSessionEntrySync(scope, { sessionId: "original", updatedAt: 1 });
  return scope;
}
const readTarget = (
  target: Parameters<typeof readSessionCreateTarget>[1],
  commitGuard?: () => void,
) => readSessionCreateTarget({ ...params, commitGuard }, target, "original", [target.canonicalKey]);

it("prepares the current creation target metadata without caller-thread SQLite", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async ({ env }) => {
    const key = "agent:main:create-target";
    const scope = seed(env, key);
    const target = await resolveGatewaySessionStoreTargetInWorker({ ...params, key, env });
    replaceSessionEntrySync(scope, {
      sessionId: "original",
      updatedAt: 2,
      sessionRoot: "/synthetic/current-root",
      skillsSnapshot: { prompt: "current metadata", skills: [] },
    });
    const sibling = "agent:main:matrix:channel:!mixed:example.org";
    replaceSessionEntrySync(
      { ...scope, sessionKey: sibling },
      { sessionId: "unrelated", updatedAt: 1 },
    );
    const database = openOpenClawAgentDatabase({ agentId: "main", env });
    database.db.prepare("UPDATE session_nodes SET entry_json = ? WHERE session_key = ?").run(
      JSON.stringify({
        sessionId: "unrelated",
        updatedAt: 1,
        delivery: normalizeSessionDeliveryState({
          context: { channel: "matrix", to: "!Mixed:example.org" },
        }),
      }),
      sibling,
    );
    database.db
      .prepare("UPDATE session_nodes SET entry_valid = 1 WHERE session_key = ?")
      .run(sibling);
    const sql = observeHostDataSql();
    try {
      expect(await readTarget(target)).toMatchObject({
        ok: true,
        value: {
          sessionId: "original",
          sessionRoot: "/synthetic/current-root",
          skillsSnapshot: { prompt: "current metadata", skills: [] },
        },
      });
      expect(sql.queries).toEqual([]);
    } finally {
      sql.restore();
    }
  });
});

it("rechecks creation authority after queued reader admission", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async ({ env }) => {
    const key = "agent:main:create-target-revoked";
    seed(env, key);
    const target = await resolveGatewaySessionStoreTargetInWorker({ cfg: {}, key, env });
    const entered = createDeferredCore();
    const release = createDeferredCore();
    const writer = runOpenClawAgentWriteAdmission({ agentId: target.agentId, env }, async () => {
      entered.resolve();
      await release.promise;
    });
    await entered.promise;
    let current = true;
    const revoked = new Error("creation caller revoked");
    const read = readTarget(target, () => {
      if (!current) {
        throw revoked;
      }
    });
    current = false;
    const refused = expect(read).rejects.toBe(revoked);
    release.resolve();
    await Promise.all([writer, refused]);
  });
});

it.for(["metadata", "database"] as const)(
  "prepares creation %s while an unrelated writer remains admitted",
  async (preparation, { signal }) => {
    await withOpenClawTestState({ scenario: "minimal" }, async ({ env }) => {
      const key = "agent:main:create-target-unblocked";
      seed(env, key);
      const target = await resolveGatewaySessionStoreTargetInWorker({ cfg: {}, key, env });
      const database = {
        agentId: target.agentId,
        path: resolveOpenClawAgentSqlitePath({ agentId: target.agentId, env }),
        env,
      };
      const execution = captureOpenClawAgentDatabaseExecution(database);
      const entered = createDeferredCore();
      const release = createDeferredCore();
      let writer: Promise<void> | undefined;
      try {
        await prepareSessionEntryReplacementDatabase(database, () => {}, execution);
        writer = runOpenClawAgentWriteAdmission(database, async () => {
          entered.resolve();
          await release.promise;
        });
        await withinTest(entered.promise, signal);
        if (preparation === "database") {
          await withinTest(
            prepareSessionEntryReplacementDatabase(database, () => {}, execution),
            signal,
          );
        } else {
          expect(await withinTest(readTarget(target), signal)).toMatchObject({
            ok: true,
            value: { sessionId: "original", updatedAt: 1 },
          });
        }
      } finally {
        release.resolve();
        await writer;
        await execution.release();
      }
    });
  },
);
