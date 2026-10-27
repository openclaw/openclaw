import { AsyncLocalStorage } from "node:async_hooks";
import { expect, it } from "vitest";
import { observeHostDataSql } from "../../test/helpers/sqlite-statement-execution-counter.js";
import { loadPinnedRuntimeConfigAsync } from "../config/runtime-snapshot.js";
import { replaceSessionEntry } from "../config/sessions/session-accessor.js";
import { memorySessionActorOwners } from "../config/sessions/session-actor-memory-owner.js";
import type { SessionEntry } from "../config/sessions/types.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { closeOpenClawAgentDatabasesAsync } from "../state/openclaw-agent-db.js";
import { resolveIncognitoOpenClawAgentSqlitePath } from "../state/openclaw-agent-db.paths.js";
import { closeStateDatabaseForTest } from "../test-utils/database-cleanup.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { loadCombinedSessionStoreForGatewayAsync as loadStore } from "./session-transcript-hit.js";

const visibleKeys = ["agent:main:visible", "agent:research:visible", "agent:retired:visible"];
it.each([
  ["all agents", {}, visibleKeys],
  ["one requested agent", { agentId: "main" }, visibleKeys.slice(0, 1)],
  ["configured agents", { configuredAgentsOnly: true }, visibleKeys.slice(0, 2)],
] as const)("projects complete entries for %s", async (_name, options, expectedKeys) => {
  await withOpenClawTestState({ label: "plugin-transcript-projection" }, async (state) => {
    const defaults = { sessionStore: { agentId: "main" } };
    const cfg: OpenClawConfig = { agents: { defaults, entries: { main: {}, research: {} } } };
    await loadPinnedRuntimeConfigAsync(async () => ({ config: cfg }));
    const fields = {
      skillsSnapshot: {
        prompt: "Saved plugin skill instructions",
        skills: [{ name: "plugin-fixture" }],
      },
      systemPromptReport: {
        source: "run",
        generatedAt: 7,
        systemPrompt: { chars: 83, projectContextChars: 31, nonProjectContextChars: 52 },
        injectedWorkspaceFiles: [],
        skills: { promptChars: 30, entries: [{ name: "plugin-fixture", blockChars: 30 }] },
        tools: { listChars: 11, schemaChars: 19, entries: [] },
      } satisfies NonNullable<SessionEntry["systemPromptReport"]>,
    };
    const updatedAt = Date.now();
    const entry = (sessionId: string, time = updatedAt) => ({
      ...fields,
      sessionId,
      updatedAt: time,
    });
    for (const agentId of ["main", "research", "retired"]) {
      await replaceSessionEntry(
        { agentId, sessionKey: `agent:${agentId}:visible` },
        entry(`${agentId}-visible`),
      );
    }
    const incognitoScope = {
      agentId: "main",
      sessionKey: "agent:main:dashboard:incognito-private",
    };
    try {
      const incognitoEntry = await replaceSessionEntry(incognitoScope, {
        ...entry("private-session"),
        incognito: true,
        skillsSnapshot: { prompt: "Private plugin instructions", skills: [] },
      });
      expect(incognitoEntry).toMatchObject({ sessionId: "private-session", incognito: true });

      // Drain fixture writes and their maintenance before observing the read itself.
      await closeOpenClawAgentDatabasesAsync();
      await closeStateDatabaseForTest();

      const invocation = new AsyncLocalStorage<boolean>();
      const queries: string[] = [];
      // Ambient WAL maintenance has its own context and is not work caused by this SDK read.
      const sql = observeHostDataSql((query) => invocation.getStore() && queries.push(query));
      let store: Awaited<ReturnType<typeof loadStore>>["store"];
      try {
        ({ store } = await invocation.run(true, () => loadStore(cfg, options)));
        expect(queries).toEqual([]);
      } finally {
        sql.restore();
        invocation.disable();
      }

      expect(Object.keys(store).toSorted()).toEqual(expectedKeys);
      for (const storedEntry of Object.values(store)) {
        expect.soft(storedEntry).toEqual(expect.objectContaining(fields));
      }
      const changedKey = expectedKeys[0]!;
      await replaceSessionEntry(
        { agentId: "main", sessionKey: changedKey },
        entry("new-incarnation", updatedAt + 1),
      );
      const current = await loadStore(cfg, options);
      expect(current.store[changedKey]?.sessionId).toBe("new-incarnation");
    } finally {
      const agentId = incognitoScope.agentId;
      const path = resolveIncognitoOpenClawAgentSqlitePath({ agentId, env: state.env });
      memorySessionActorOwners.closeDatabase({ agentId, path });
    }
  });
});
