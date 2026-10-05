import { expect, it } from "vitest";
import { observeHostDataSql } from "../../test/helpers/sqlite-statement-execution-counter.js";
import { replaceSessionEntrySync } from "../config/sessions/session-accessor.sqlite-entry.js";
import { createDeferredCore } from "../shared/deferred.js";
import { openOpenClawAgentDatabase } from "../state/openclaw-agent-db.js";
import { runOpenClawAgentWriteAdmission } from "../state/openclaw-agent-write-admission.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { normalizeSessionDeliveryState } from "../utils/delivery-context.shared.js";
import { readSessionCreateTarget } from "./session-create-target.js";
import { resolveGatewaySessionStoreTargetInWorker } from "./session-utils-store-worker.js";

it("prepares the current creation target metadata without caller-thread SQLite", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async ({ env }) => {
    const key = "agent:main:create-target";
    const params = {
      cfg: {},
      key,
      commandSource: "test",
      operatorRoleActor: { kind: "system" as const },
    };
    const scope = { agentId: "main", sessionKey: key, env };
    replaceSessionEntrySync(scope, { sessionId: "original", updatedAt: 1 });
    const target = await resolveGatewaySessionStoreTargetInWorker({ ...params, env });
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
      expect(
        await readSessionCreateTarget(params, {
          target,
          expectedSessionId: "original",
          lifecycleIdentities: [key],
        }),
      ).toMatchObject({
        ok: true,
        value: {
          entry: {
            sessionId: "original",
            sessionRoot: "/synthetic/current-root",
            skillsSnapshot: { prompt: "current metadata", skills: [] },
          },
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
    replaceSessionEntrySync(
      { agentId: "main", sessionKey: key, env },
      { sessionId: "original", updatedAt: 1 },
    );
    const target = await resolveGatewaySessionStoreTargetInWorker({ cfg: {}, key, env });
    const entered = createDeferredCore();
    const release = createDeferredCore();
    const writer = runOpenClawAgentWriteAdmission(
      { agentId: target.agentId, path: target.storePath, env },
      async () => {
        entered.resolve();
        await release.promise;
      },
    );
    await entered.promise;
    let current = true;
    const revoked = new Error("creation caller revoked");
    const read = readSessionCreateTarget(
      {
        cfg: {},
        commandSource: "test",
        commitGuard: () => {
          if (!current) {
            throw revoked;
          }
        },
      },
      { target, expectedSessionId: "original", lifecycleIdentities: [key] },
    );
    current = false;
    const refused = expect(read).rejects.toBe(revoked);
    release.resolve();
    await Promise.all([writer, refused]);
  });
});
