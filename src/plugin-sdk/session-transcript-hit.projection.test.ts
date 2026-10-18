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
import { loadCombinedSessionStoreForGatewayAsync } from "./session-transcript-hit.js";

it.each([
  {
    name: "all agents",
    options: {},
    expectedKeys: ["agent:main:visible", "agent:research:visible", "agent:retired:visible"],
  },
  {
    name: "one requested agent",
    options: { agentId: "main" },
    expectedKeys: ["agent:main:visible"],
  },
  {
    name: "configured agents",
    options: { configuredAgentsOnly: true },
    expectedKeys: ["agent:main:visible", "agent:research:visible"],
  },
])("returns complete non-incognito entries for $name", async ({ options, expectedKeys }) => {
  await withOpenClawTestState({ label: "plugin-transcript-projection" }, async (state) => {
    const cfg: OpenClawConfig = {
      agents: {
        defaults: { sessionStore: { agentId: "main" } },
        entries: { main: {}, research: {} },
      },
    };
    await loadPinnedRuntimeConfigAsync(async () => ({ config: cfg }));
    const skillsSnapshot = {
      prompt: "Saved plugin skill instructions",
      skills: [{ name: "plugin-fixture" }],
    };
    const updatedAt = Date.now();
    const systemPromptReport: NonNullable<SessionEntry["systemPromptReport"]> = {
      source: "run",
      generatedAt: 7,
      systemPrompt: { chars: 83, projectContextChars: 31, nonProjectContextChars: 52 },
      injectedWorkspaceFiles: [],
      skills: { promptChars: 30, entries: [{ name: "plugin-fixture", blockChars: 30 }] },
      tools: { listChars: 11, schemaChars: 19, entries: [] },
    };
    for (const agentId of ["main", "research", "retired"]) {
      await replaceSessionEntry(
        { agentId, sessionKey: `agent:${agentId}:visible` },
        {
          sessionId: `${agentId}-visible`,
          updatedAt,
          skillsSnapshot,
          systemPromptReport,
        },
      );
    }
    const incognitoScope = {
      agentId: "main",
      sessionKey: "agent:main:dashboard:incognito-private",
    };
    try {
      const incognitoEntry = await replaceSessionEntry(incognitoScope, {
        sessionId: "private-session",
        updatedAt,
        incognito: true,
        skillsSnapshot: { prompt: "Private plugin instructions", skills: [] },
        systemPromptReport,
      });
      expect(incognitoEntry).toMatchObject({
        sessionId: "private-session",
        incognito: true,
      });

      // Drain fixture writes and their maintenance before observing the read itself.
      await closeOpenClawAgentDatabasesAsync();
      await closeStateDatabaseForTest();

      const invocation = new AsyncLocalStorage<boolean>();
      const queries: string[] = [];
      // Ambient WAL maintenance has its own context and is not work caused by this SDK read.
      const sql = observeHostDataSql((query) => {
        if (invocation.getStore()) {
          queries.push(query);
        }
      });
      let store: Awaited<ReturnType<typeof loadCombinedSessionStoreForGatewayAsync>>["store"];
      try {
        ({ store } = await invocation.run(true, () =>
          loadCombinedSessionStoreForGatewayAsync(cfg, options),
        ));
        expect(queries).toEqual([]);
      } finally {
        sql.restore();
        invocation.disable();
      }

      expect(Object.keys(store).toSorted()).toEqual(expectedKeys);
      for (const entry of Object.values(store)) {
        expect.soft(entry.skillsSnapshot).toEqual(skillsSnapshot);
        expect.soft(entry.systemPromptReport).toEqual(systemPromptReport);
      }
      const changedKey = expectedKeys[0]!;
      await replaceSessionEntry(
        { agentId: "main", sessionKey: changedKey },
        {
          sessionId: "new-incarnation",
          updatedAt: updatedAt + 1,
          skillsSnapshot,
          systemPromptReport,
        },
      );
      const current = await loadCombinedSessionStoreForGatewayAsync(cfg, options);
      expect(current.store[changedKey]?.sessionId).toBe("new-incarnation");
    } finally {
      memorySessionActorOwners.closeDatabase({
        agentId: incognitoScope.agentId,
        path: resolveIncognitoOpenClawAgentSqlitePath({
          agentId: incognitoScope.agentId,
          env: state.env,
        }),
      });
    }
  });
});
