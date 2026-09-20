import path from "node:path";
import { describe, expect, it } from "vitest";
import { trackSqliteStatementExecutions } from "../../../test/helpers/sqlite-statement-execution-counter.js";
import {
  loadSessionEntry,
  replaceSessionEntrySync,
} from "../../config/sessions/session-accessor.js";
import type { SessionEntry } from "../../config/sessions/types.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { openOpenClawAgentDatabase } from "../../state/openclaw-agent-db.js";
import {
  withOpenClawTestState,
  type OpenClawTestState,
} from "../../test-utils/openclaw-test-state.js";
import { resolveWorkerSessionTarget } from "./session-target.js";

function config(state: OpenClawTestState): OpenClawConfig {
  return {
    agents: { list: [{ id: "main", default: true }, { id: "work" }] },
    session: {
      store: path.join(state.stateDir, "agents", "{agentId}", "sessions", "sessions.json"),
    },
  };
}

function writeEntry(scope: Parameters<typeof replaceSessionEntrySync>[0], entry: SessionEntry) {
  // Partial patches advance activity time; exact writes preserve the freshness/ambiguity fixture.
  replaceSessionEntrySync(scope, entry);
  expect(loadSessionEntry(scope)).toMatchObject({
    sessionId: entry.sessionId,
    updatedAt: entry.updatedAt,
  });
}

describe("worker session target", () => {
  it("reads the selected full entry without hydrating unrelated prompt snapshots", async () => {
    await withOpenClawTestState(
      { label: "worker-target-payload", scenario: "minimal" },
      async (state) => {
        const cfg = config(state);
        const scope = {
          agentId: "main",
          sessionKey: "agent:main:selected",
          storePath: path.join(state.sessionsDir("main"), "sessions.json"),
        };
        const prompt = "selected skill instructions ".repeat(160).slice(0, 4096);
        const unrelatedPrompt = "unrelated skill instructions ".repeat(2400).slice(0, 65536);
        const entry: SessionEntry = {
          sessionId: "selected",
          updatedAt: 10,
          authProfileOverride: "openai:operator",
          authProfileOverrideSource: "user",
          skillsSnapshot: { prompt, skills: [] },
          systemPromptReport: {
            source: "run",
            generatedAt: 1,
            systemPrompt: { chars: 100, projectContextChars: 40, nonProjectContextChars: 60 },
            injectedWorkspaceFiles: [],
            skills: { promptChars: prompt.length, entries: [] },
            tools: { listChars: 0, schemaChars: 0, entries: [] },
          },
        };
        writeEntry(scope, entry);
        for (let index = 0; index < 8; index += 1) {
          writeEntry(
            { ...scope, sessionKey: `agent:main:unrelated-${index}` },
            {
              sessionId: `unrelated-${index}`,
              updatedAt: 20,
              skillsSnapshot: { prompt: unrelatedPrompt, skills: [] },
            },
          );
        }
        const database = openOpenClawAgentDatabase({ agentId: "main" });
        const reads = trackSqliteStatementExecutions(database.db, ["entries"], (sql) =>
          /\bfrom\s+"session_nodes"/iu.test(sql) ? "entries" : null,
        );
        try {
          const target = resolveWorkerSessionTarget(cfg, entry.sessionId);
          expect(target).toMatchObject({
            agentId: "main",
            sessionId: entry.sessionId,
            sessionKey: scope.sessionKey,
            sessionEntry: entry,
          });
          expect(target?.sessionStore[scope.sessionKey]).toEqual(target?.sessionEntry);
          expect(reads.counts.entries).toBeGreaterThan(0);
          expect(reads.rowCounts.entries).toBeGreaterThan(0);
          expect(reads.textBytes.entries).toBeGreaterThanOrEqual(Buffer.byteLength(prompt));
          // Discovery may read small metadata for every candidate, but only the chosen prompt crosses into JS.
          expect(reads.textBytes.entries).toBeLessThan(Buffer.byteLength(unrelatedPrompt));
        } finally {
          reads.restore();
        }
        expect(
          loadSessionEntry({ ...scope, sessionKey: "agent:main:unrelated-0" })?.skillsSnapshot
            ?.prompt,
        ).toBe(unrelatedPrompt);
      },
    );
  });

  it.each([
    {
      keys: ["agent:main:other", "agent:work:target"],
      updatedAt: [30, 10],
      expected: "agent:work:target",
    },
    {
      keys: ["agent:main:first", "agent:work:second"],
      updatedAt: [10, 20],
      expected: "agent:work:second",
    },
    { keys: ["agent:main:first", "agent:work:second"], updatedAt: [10, 10], expected: undefined },
    {
      keys: ["agent:main:first:target", "agent:work:second:target"],
      updatedAt: [10, 10],
      expected: undefined,
    },
  ] as const)(
    "preserves duplicate session selection for $keys",
    async ({ keys, updatedAt, expected }) => {
      await withOpenClawTestState(
        { label: "worker-target-selection", scenario: "minimal" },
        async (state) => {
          const cfg = config(state);
          for (const [index, sessionKey] of keys.entries()) {
            const agentId = index === 0 ? "main" : "work";
            writeEntry(
              {
                agentId,
                sessionKey,
                storePath: path.join(state.sessionsDir(agentId), "sessions.json"),
              },
              { sessionId: "target", updatedAt: index === 0 ? updatedAt[0] : updatedAt[1] },
            );
          }
          expect(resolveWorkerSessionTarget(cfg, "target")?.sessionKey).toBe(expected);
          expect(resolveWorkerSessionTarget(cfg, "missing")).toBeUndefined();
        },
      );
    },
  );

  it.each(["global", "unknown"])(
    "retains the first %s sentinel's owner before filtering by id",
    async (sessionKey) => {
      await withOpenClawTestState(
        { label: "worker-target-sentinel", scenario: "minimal" },
        async (state) => {
          const cfg = config(state);
          for (const agentId of ["main", "work"]) {
            writeEntry(
              {
                agentId,
                sessionKey,
                storePath: path.join(state.sessionsDir(agentId), "sessions.json"),
              },
              { sessionId: `${agentId}-sentinel`, updatedAt: 10 },
            );
          }
          expect(resolveWorkerSessionTarget(cfg, "main-sentinel")).toMatchObject({
            agentId: "main",
            sessionKey,
          });
          expect(resolveWorkerSessionTarget(cfg, "work-sentinel")).toBeUndefined();
        },
      );
    },
  );

  it("refreshes identity and duplicate freshness after a warm lookup", async () => {
    await withOpenClawTestState(
      { label: "worker-target-refresh", scenario: "minimal" },
      async (state) => {
        const cfg = config(state);
        const main = {
          agentId: "main",
          sessionKey: "agent:main:first",
          storePath: path.join(state.sessionsDir("main"), "sessions.json"),
        };
        const work = {
          agentId: "work",
          sessionKey: "agent:work:second",
          storePath: path.join(state.sessionsDir("work"), "sessions.json"),
        };
        writeEntry(main, { sessionId: "old-id", updatedAt: 10 });
        expect(resolveWorkerSessionTarget(cfg, "old-id")?.sessionKey).toBe(main.sessionKey);
        writeEntry(main, { sessionId: "new-id", updatedAt: 20 });
        expect(resolveWorkerSessionTarget(cfg, "old-id")).toBeUndefined();
        expect(resolveWorkerSessionTarget(cfg, "new-id")?.sessionKey).toBe(main.sessionKey);
        writeEntry(work, { sessionId: "new-id", updatedAt: 10 });
        expect(resolveWorkerSessionTarget(cfg, "new-id")?.sessionKey).toBe(main.sessionKey);
        writeEntry(work, { sessionId: "new-id", updatedAt: 30 });
        expect(resolveWorkerSessionTarget(cfg, "new-id")?.sessionKey).toBe(work.sessionKey);
      },
    );
  });
});
