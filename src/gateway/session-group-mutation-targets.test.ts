import fs from "node:fs";
import { afterEach, expect, test, vi } from "vitest";
import { runCliProcessChild } from "../cli/cli-process-child.test-helpers.js";
import * as runtimeConfig from "../config/runtime-snapshot.js";
import { loadSessionEntry, upsertSessionEntryCore } from "../config/sessions/session-accessor.js";
import type { InternalSessionEntry } from "../config/sessions/types.js";
import { resolveRuntimeWorkerArgv } from "../infra/runtime-worker-url.js";
import * as sqliteIntegrity from "../infra/sqlite-integrity.js";
import * as sqliteWal from "../infra/sqlite-wal.js";
import * as agentDatabaseLeases from "../state/openclaw-agent-db-lease.js";
import { closeOpenClawAgentDatabasesAsync } from "../state/openclaw-agent-db.js";
import { listOpenClawAgentDatabasesForTest } from "../state/openclaw-agent-db.test-support.js";
import { setStateDirEnv, withStateDirEnv } from "../test-helpers/state-dir-env.js";
import { readSessionGroupMembershipInWorker } from "./session-group-catalog.js";

const handleCap = 64;
afterEach(() => {
  runtimeConfig.clearRuntimeConfigSnapshot();
  vi.restoreAllMocks();
});
async function seedGroups(
  stateDir: string,
  scopes: readonly { agentId: string; sessionKey: string }[],
  extra: Partial<InternalSessionEntry> = {},
  cold = false,
) {
  setStateDirEnv(fs.realpathSync(stateDir));
  const config = {
    agents: { entries: Object.fromEntries(scopes.map(({ agentId }) => [agentId, {}])) },
  };
  runtimeConfig.setRuntimeConfigSnapshot(config);
  const entry = { sessionId: "group-member", updatedAt: 1, category: "Shared work", ...extra };
  for (const scope of scopes) {
    await upsertSessionEntryCore(scope, entry);
  }
  if (cold) {
    await closeOpenClawAgentDatabasesAsync(stateDir);
  }
  return config;
}
const readGroups = async (config: Parameters<typeof readSessionGroupMembershipInWorker>[0]) =>
  new Map((await readSessionGroupMembershipInWorker(config, process.env)).groups);

test.each([false, true])(
  "discovers current group members without decoding saved prompts (cold=%s)",
  async (cold) => {
    await withStateDirEnv("openclaw-session-group-metadata-", async ({ stateDir }) => {
      const scopes = [
        { agentId: "main", sessionKey: "agent:main:group-member" },
        { agentId: "research", sessionKey: "agent:research:matrix:group:!Room:example.org" },
      ] as const;
      const savedPrompts = {
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
      const entry = { ...savedPrompts, category: " Shared work " };
      const config = await seedGroups(stateDir, scopes, entry, cold);
      const parse = vi.spyOn(JSON, "parse");
      const readTargets = async () => {
        parse.mockClear();
        const targets = await readGroups(config);
        expect(
          parse.mock.calls.some(([json]) => /"(skillsSnapshot|systemPromptReport)"/.test(json)),
        ).toBe(false);
        return targets;
      };
      const expectRenamed = async (name: string) => {
        const expected = new Map([
          [name, [scopes[0]]],
          ["Shared work", [scopes[1]]],
        ]);
        expect(await readTargets()).toEqual(expected);
      };
      expect(await readTargets()).toEqual(new Map([["Shared work", scopes]]));
      await upsertSessionEntryCore(scopes[0], { category: "Renamed" });
      await expectRenamed("Renamed");
      const entryUrl = new URL("../config/sessions/session-accessor.ts", import.meta.url);
      const cleanupUrl = new URL("../test-utils/session-state-cleanup.ts", import.meta.url);
      const configUrl = new URL("../config/runtime-snapshot.ts", import.meta.url);
      // A foreign canonical writer refreshes metadata without this process's publications.
      const external = await runCliProcessChild({
        nodeArgs: [
          ...resolveRuntimeWorkerArgv(entryUrl).slice(0, -1),
          "--input-type=module",
          "--eval",
          `import { upsertSessionEntryCore } from ${JSON.stringify(entryUrl.href)};
             import { cleanupSessionStateForTest } from ${JSON.stringify(cleanupUrl.href)};
             import { setRuntimeConfigSnapshot } from ${JSON.stringify(configUrl.href)};
             setRuntimeConfigSnapshot(${JSON.stringify(config)});
             try {
               await upsertSessionEntryCore(${JSON.stringify(scopes[0])}, { category: "External" });
             } finally {
               await cleanupSessionStateForTest({ stateDir: process.env.OPENCLAW_STATE_DIR });
             }`,
        ],
        env: { ...process.env },
      });
      expect(external.code, external.stderr).toBe(0);
      await expectRenamed("External");
      parse.mockRestore();
      expect(loadSessionEntry(scopes[0])).toMatchObject(savedPrompts);
    });
  },
);

test("discovers groups above the handle cap without writable database maintenance", async () => {
  await withStateDirEnv("openclaw-session-group-readonly-", async ({ stateDir }) => {
    const scopes = Array.from({ length: handleCap + 1 }, (_, index) => ({
      agentId: `group-reader-${index}`,
      sessionKey: `agent:group-reader-${index}:main`,
    }));
    const config = await seedGroups(stateDir, scopes, {}, true);
    const maintenance = [
      vi.spyOn(sqliteIntegrity, "assertSqliteIntegrity"),
      vi.spyOn(agentDatabaseLeases, "claimOpenClawAgentDatabaseLease"),
      vi.spyOn(agentDatabaseLeases, "releaseOpenClawAgentDatabaseLease"),
    ];
    const wal = vi.spyOn(sqliteWal, "configureSqliteConnectionPragmas");
    expect((await readGroups(config)).get("Shared work")).toEqual(scopes);
    expect(maintenance.map((spy) => spy.mock.calls)).toEqual([[], [], []]);
    expect(
      wal.mock.calls.filter(([, options]) => options?.databaseLabel?.startsWith("openclaw-agent:")),
    ).toEqual([]);
    expect(listOpenClawAgentDatabasesForTest()).toEqual([]);
  });
});
