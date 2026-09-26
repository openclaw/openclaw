import { DatabaseSync } from "node:sqlite";
import { expect, test, vi } from "vitest";
import { loadSessionEntry, upsertSessionEntryCore } from "../config/sessions/session-accessor.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import * as sqliteIntegrity from "../infra/sqlite-integrity.js";
import * as sqliteWal from "../infra/sqlite-wal.js";
import * as agentDatabaseLeases from "../state/openclaw-agent-db-lease.js";
import {
  closeOpenClawAgentDatabasesAsync,
  closeOpenClawAgentDatabasesForTest,
  openOpenClawAgentDatabase,
} from "../state/openclaw-agent-db.js";
import { listOpenClawAgentDatabasesForTest } from "../state/openclaw-agent-db.test-support.js";
import { withStateDirEnv } from "../test-helpers/state-dir-env.js";
import { readSessionGroupMembershipInWorker } from "./session-group-catalog.js";

const EXPECTED_OPEN_HANDLE_CAP = 64;

test.each([false, true])(
  "discovers current group members without decoding saved prompts (cold=%s)",
  async (cold) => {
    await withStateDirEnv("openclaw-session-group-metadata-", async ({ stateDir }) => {
      const scopes = [
        { agentId: "main", sessionKey: "agent:main:group-member" },
        { agentId: "research", sessionKey: "agent:research:matrix:group:!Room:example.org" },
      ] as const;
      const config = {
        agents: { list: [{ id: "main", default: true }, { id: "research" }] },
      } satisfies OpenClawConfig;
      const entry = {
        sessionId: "group-member",
        updatedAt: 1,
        category: " Shared work ",
        skillsSnapshot: { prompt: "unneeded-group-prompt".repeat(4096), skills: [] },
        systemPromptReport: {
          source: "run" as const,
          generatedAt: 1,
          systemPrompt: { chars: 1, projectContextChars: 0, nonProjectContextChars: 1 },
          injectedWorkspaceFiles: [],
          skills: { promptChars: 0, entries: [] },
          tools: { listChars: 0, schemaChars: 0, entries: [] },
        },
      };
      const parse = vi.spyOn(JSON, "parse");
      const readTargets = async () => {
        parse.mockClear();
        const targets = new Map(
          (await readSessionGroupMembershipInWorker(config, process.env)).groups,
        );
        expect(
          parse.mock.calls.filter(
            ([json]) => json.includes('"skillsSnapshot"') || json.includes('"systemPromptReport"'),
          ),
        ).toEqual([]);
        return targets;
      };
      try {
        for (const scope of scopes) {
          await upsertSessionEntryCore(scope, entry);
        }
        if (cold) {
          await closeOpenClawAgentDatabasesAsync(stateDir);
          closeOpenClawAgentDatabasesForTest(stateDir);
        }
        expect(await readTargets()).toEqual(new Map([["Shared work", scopes]]));
        await upsertSessionEntryCore(scopes[0], { ...entry, category: "Renamed" });
        expect(await readTargets()).toEqual(
          new Map([
            ["Renamed", [scopes[0]]],
            ["Shared work", [scopes[1]]],
          ]),
        );
        const database = openOpenClawAgentDatabase(scopes[0]);
        const external = new DatabaseSync(database.path);
        try {
          external
            .prepare(
              "UPDATE session_nodes SET entry_json = json_set(entry_json, '$.category', ?) WHERE session_key = ?",
            )
            .run("External", scopes[0].sessionKey);
        } finally {
          external.close();
        }
        expect(await readTargets()).toEqual(
          new Map([
            ["External", [scopes[0]]],
            ["Shared work", [scopes[1]]],
          ]),
        );
        parse.mockRestore();
        expect(loadSessionEntry(scopes[0])).toMatchObject({
          skillsSnapshot: entry.skillsSnapshot,
          systemPromptReport: entry.systemPromptReport,
        });
      } finally {
        parse.mockRestore();
      }
    });
  },
);

test("discovers groups across more than the handle cap without writable database maintenance", async () => {
  await withStateDirEnv("openclaw-session-group-readonly-", async ({ stateDir }) => {
    const agentIds = Array.from(
      { length: EXPECTED_OPEN_HANDLE_CAP + 1 },
      (_, index) => `group-reader-${index}`,
    );
    const config = {
      agents: {
        list: agentIds.map((id, index) => ({ id, ...(index === 0 ? { default: true } : {}) })),
      },
    } satisfies OpenClawConfig;

    for (const [index, agentId] of agentIds.entries()) {
      await upsertSessionEntryCore(
        { agentId, sessionKey: `agent:${agentId}:main` },
        { category: "Shared work", sessionId: `group-session-${index}`, updatedAt: index + 1 },
      );
    }
    await closeOpenClawAgentDatabasesAsync(stateDir);
    closeOpenClawAgentDatabasesForTest(stateDir);

    const integritySpy = vi.spyOn(sqliteIntegrity, "assertSqliteIntegrity");
    const claimSpy = vi.spyOn(agentDatabaseLeases, "claimOpenClawAgentDatabaseLease");
    const releaseSpy = vi.spyOn(agentDatabaseLeases, "releaseOpenClawAgentDatabaseLease");
    const walSpy = vi.spyOn(sqliteWal, "configureSqliteConnectionPragmas");

    try {
      const targets = new Map(
        (await readSessionGroupMembershipInWorker(config, process.env)).groups,
      );

      expect(targets.get("Shared work")).toEqual(
        agentIds.map((agentId) => ({ agentId, sessionKey: `agent:${agentId}:main` })),
      );
      expect(integritySpy.mock.calls.length).toBe(0);
      expect(claimSpy.mock.calls.length).toBe(0);
      expect(releaseSpy.mock.calls.length).toBe(0);
      expect(
        walSpy.mock.calls.filter(([, options]) =>
          options?.databaseLabel?.startsWith("openclaw-agent:"),
        ),
      ).toEqual([]);
      expect(listOpenClawAgentDatabasesForTest()).toEqual([]);
    } finally {
      integritySpy.mockRestore();
      claimSpy.mockRestore();
      releaseSpy.mockRestore();
      walSpy.mockRestore();
    }
  });
});
