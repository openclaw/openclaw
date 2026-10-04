import "../test-utils/prepare-compiled-subprocesses.js";
import assert from "node:assert/strict";
import { expect, it } from "vitest";
import { resolveIncognitoOpenClawAgentSqlitePath } from "../state/openclaw-agent-db.paths.js";
import { captureOpenClawAgentDatabaseExecution } from "../state/openclaw-agent-execution.js";
import { observeMainThreadSql } from "../test-utils/main-thread-sql-spies.test-support.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { readResidentSessionRow } from "./session-row-projection-materialize.js";
import { createIncognitoSessionRow } from "./session-row-projection-record.js";
import { buildSessionListRowMetadataContext } from "./session-utils-projection.js";
import { presentSessionRow } from "./session-utils-row.js";

it("materializes actor-prepared private entries and lineage without host SQLite", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
    const cfg = { agents: { entries: { main: {} } } };
    const authority = { assertCurrent() {} };
    const actor = await captureOpenClawAgentDatabaseExecution({
      kind: "ephemeral",
      agentId: "main",
      env: state.env,
      authority,
    });
    assert(actor);
    try {
      const parentKey = "agent:main:dashboard:incognito-prepared-parent";
      const key = "agent:main:dashboard:incognito-prepared-row";
      const childKey = "agent:main:dashboard:incognito-prepared-child";
      const parent = await actor.sessions.create(authority, {
        sessionKey: parentKey,
        entry: {
          sessionId: "prepared-parent",
          updatedAt: Date.now(),
          providerOverride: "ollama",
          modelOverride: "qwen3:14b",
          modelOverrideSource: "user",
          modelOverrideRouteResolution: "resolved",
        },
      });
      const selected = await actor.sessions.create(authority, {
        sessionKey: key,
        entry: {
          sessionId: "prepared-row",
          updatedAt: Date.now(),
          label: "Prepared private row",
          parentSessionKey: parentKey,
        },
      });
      const child = await actor.sessions.create(authority, {
        sessionKey: childKey,
        entry: {
          sessionId: "prepared-child",
          updatedAt: Date.now(),
          parentSessionKey: key,
        },
      });
      assert(parent.entry && selected.entry && child.entry);
      const row = createIncognitoSessionRow({
        cfg,
        key,
        agentId: "main",
        storePath: resolveIncognitoOpenClawAgentSqlitePath({ agentId: "main", env: state.env }),
        entry: selected.entry,
        membership: actor.sessions.readSharing(key)?.membership,
        prepared: {
          relatedEntries: { [parentKey]: parent.entry, [childKey]: child.entry },
          databaseFacts: {
            sessionKey: key,
            entry: selected.entry,
            hasBoard: false,
            acpMeta: null,
            repositoryWorkspace: null,
          },
        },
        source: {
          identity: actor.identity.incarnation,
          assertCurrent: selected.claim.assertCurrent,
        },
      });
      assert(row.entry);
      const preparedRow = { ...row, entry: row.entry };
      const context = buildSessionListRowMetadataContext({
        now: Date.now(),
        sessionKeys: [parentKey, key, childKey],
      });
      const render = () =>
        readResidentSessionRow({
          row: preparedRow,
          cfg,
          modelCatalog: [],
          configuredAgentIds: new Set(["main"]),
          context,
          subagentInputs: context.subagentRuns.inputs,
          gatewayContext: undefined,
          links: [],
          readSourceEntry: () => undefined,
        });
      const sql = observeMainThreadSql();
      try {
        const prepared = render();
        expect(presentSessionRow(prepared.materialized, { now: Date.now() })).toMatchObject({
          key,
          sessionId: "prepared-row",
          incognito: true,
          label: "Prepared private row",
          model: "qwen3:14b",
          modelOverrideSource: "inherited",
          childSessions: [childKey],
        });
        expect(prepared.hasBoard).toBe(false);
        sql.expectIdle();
      } finally {
        sql.restore();
      }
      await actor.close();
      expect(render).toThrow("Incognito session ended");
    } finally {
      await actor.close();
    }
  });
});
