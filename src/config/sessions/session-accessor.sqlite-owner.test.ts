import type { StatementSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  FIRST_USE_ADDITIVE_AGENT_COLUMN_DEFINITIONS,
  SESSION_OWNER_COLUMN_DEFINITIONS,
} from "../../state/openclaw-agent-db-additive-columns.js";
import {
  closeOpenClawAgentDatabasesForTest,
  openOpenClawAgentDatabase,
  runOpenClawAgentWriteTransaction,
} from "../../state/openclaw-agent-db.js";
import { resolveIncognitoOpenClawAgentSqlitePath } from "../../state/openclaw-agent-db.paths.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import {
  assignSessionOwner,
  loadSessionEntry,
  upsertSessionEntryCore,
} from "./session-accessor.js";

afterEach(() => {
  closeOpenClawAgentDatabasesForTest();
});

describe("SQLite session owner assignment", () => {
  it("guards incognito owner assignments without querying session rows", async () => {
    await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
      const scope = {
        agentId: "main",
        env: state.env,
        sessionKey: "agent:main:dashboard:incognito-owner",
      };
      const entry = {
        sessionId: "incognito-owner",
        updatedAt: 1,
        lifecycleRevision: "original-generation",
        incognito: true as const,
        createdActor: { type: "human" as const, source: "profile" as const, id: "creator" },
      };
      await upsertSessionEntryCore(scope, entry);
      const database = openOpenClawAgentDatabase({
        agentId: scope.agentId,
        env: state.env,
        path: resolveIncognitoOpenClawAgentSqlitePath(scope),
      });
      const prototype: StatementSync = Object.getPrototypeOf(database.db.prepare("SELECT 1"));
      const methods = (["all", "get", "run", "iterate"] as const).map((method) =>
        vi.spyOn(prototype, method),
      );
      const sessionRowReads = () =>
        methods
          .flatMap((method) => method.mock.contexts)
          .map((statement) => (statement as StatementSync).sourceSQL)
          .filter((sql) => /from ["`]?session_nodes["`]?/i.test(sql));
      const assignment = {
        actor: { type: "agent" as const, id: "research" },
        assignedBy: { type: "human" as const, id: "creator" },
        assignedAt: 1234,
      };
      const params = {
        owner: assignment.actor,
        assignedBy: assignment.assignedBy,
        assignedAt: assignment.assignedAt,
        expectedSessionId: entry.sessionId,
        expectedEntry: entry,
      };
      try {
        expect(assignSessionOwner(scope, params)).toEqual(assignment);
        expect(sessionRowReads()).toEqual([]);

        await upsertSessionEntryCore(scope, {
          ...entry,
          lifecycleRevision: "replacement-generation",
          owner: assignment,
        });
        // Observe assignment guards separately from the fixture's lifecycle mutation.
        for (const method of methods) {
          method.mockClear();
        }
        expect(() =>
          assignSessionOwner(scope, { ...params, expectedSessionId: "replaced-session" }),
        ).toThrow("session changed before owner assignment");
        expect(() => assignSessionOwner(scope, params)).toThrow(
          "session ownership changed before owner assignment",
        );
        expect(sessionRowReads()).toEqual([]);
      } finally {
        for (const method of methods) {
          method.mockRestore();
        }
      }
      expect(loadSessionEntry(scope)?.owner).toEqual(assignment);
    });
  });

  it("refuses stale session identity and lifecycle before assigning an owner", async () => {
    await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
      const scope = {
        agentId: "main",
        env: state.env,
        sessionKey: "agent:main:guarded-owner",
      };
      await upsertSessionEntryCore(scope, {
        sessionId: "session-original",
        updatedAt: 1,
        lifecycleRevision: "original-generation",
        createdActor: { type: "human", source: "profile", id: "profile-creator" },
      });
      const expectedEntry = loadSessionEntry(scope)!;
      const assignment = {
        owner: { type: "agent" as const, id: "research" },
        assignedBy: { type: "human" as const, id: "profile-assigner" },
      };
      expect(() =>
        assignSessionOwner(scope, { ...assignment, expectedSessionId: "session-replaced" }),
      ).toThrow("session changed before owner assignment");
      expect(loadSessionEntry(scope)?.owner).toBeUndefined();

      await upsertSessionEntryCore(scope, {
        ...expectedEntry,
        lifecycleRevision: "replacement-generation",
      });
      expect(() =>
        assignSessionOwner(scope, {
          ...assignment,
          expectedSessionId: expectedEntry.sessionId,
          expectedEntry,
        }),
      ).toThrow("session ownership changed before owner assignment");
      expect(loadSessionEntry(scope)?.owner).toBeUndefined();
    });
  });

  it("lazily adds bare columns and preserves the assignment across reopen", async () => {
    await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
      const scope = {
        agentId: "main",
        env: state.env,
        sessionKey: "agent:main:owned-session",
      };
      await upsertSessionEntryCore(scope, {
        sessionId: "session-owned",
        updatedAt: 1,
        createdActor: { type: "human", source: "profile", id: "profile-creator" },
      });
      const initial = openOpenClawAgentDatabase({ agentId: "main", env: state.env });
      for (const { columnName, tableName } of FIRST_USE_ADDITIVE_AGENT_COLUMN_DEFINITIONS) {
        initial.db.exec(`ALTER TABLE ${tableName} DROP COLUMN ${columnName};`);
      }
      closeOpenClawAgentDatabasesForTest();

      expect(loadSessionEntry(scope)).toMatchObject({
        createdActor: { type: "human", source: "profile", id: "profile-creator" },
      });
      expect(loadSessionEntry(scope)?.owner).toBeUndefined();

      expect(() =>
        runOpenClawAgentWriteTransaction(
          () => {
            expect(
              assignSessionOwner(scope, {
                owner: { type: "agent", id: "rolled-back-owner" },
                assignedBy: { type: "human", id: "profile-assigner" },
                assignedAt: 1233,
              }),
            ).not.toBeNull();
            throw new Error("roll back owner schema");
          },
          { agentId: "main", env: state.env },
        ),
      ).toThrow("roll back owner schema");
      expect(loadSessionEntry(scope)?.owner).toBeUndefined();

      const assignment = {
        actor: { type: "agent" as const, id: "research" },
        assignedBy: { type: "human" as const, id: "profile-assigner" },
        assignedAt: 1234,
      };
      expect(
        assignSessionOwner(scope, {
          owner: assignment.actor,
          assignedBy: assignment.assignedBy,
          assignedAt: assignment.assignedAt,
        }),
      ).toEqual(assignment);
      expect(loadSessionEntry(scope)?.owner).toEqual(assignment);

      closeOpenClawAgentDatabasesForTest();
      expect(loadSessionEntry(scope)?.owner).toEqual(assignment);
      const reopened = openOpenClawAgentDatabase({ agentId: "main", env: state.env });
      const columns = reopened.db.prepare("PRAGMA table_info(session_nodes)").all() as Array<{
        name: string;
        notnull: number;
        dflt_value: unknown;
        type: string;
      }>;
      expect(columns.some((column) => column.name === "legacy_acp_migration_json")).toBe(false);
      for (const definition of SESSION_OWNER_COLUMN_DEFINITIONS) {
        expect(columns.find((column) => column.name === definition.columnName)).toMatchObject({
          type: definition.dataType,
          notnull: 0,
          dflt_value: null,
        });
      }
    });
  });
});
