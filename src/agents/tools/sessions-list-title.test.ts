import path from "node:path";
import { expect, test, vi } from "vitest";
import { trackSqliteStatementExecutions } from "../../../test/helpers/sqlite-statement-execution-counter.js";
import {
  appendTranscriptMessageSync,
  loadSessionEntryReadOnly,
  readSessionTranscriptWatermark,
  replaceSessionEntrySync,
} from "../../config/sessions/session-accessor.js";
import { openOpenClawAgentDatabase } from "../../state/openclaw-agent-db.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import type { AgentToolGatewayRequestCaller } from "./in-process-gateway.js";
import type { GatewaySessionListRow, SessionListRow } from "./sessions-helpers.js";
import { createSessionsListTool } from "./sessions-list-tool.js";
import { VALID_CONFIG } from "./sessions-list.test-support.js";

const PAYLOAD_MARKER = "unused inventory transcript ";
type FixtureRow = {
  row: Partial<GatewaySessionListRow> & { subject?: string };
  transcript?: "large" | "small";
};

async function withInventory(
  definitions: FixtureRow[],
  run: (fixture: {
    render: (includeLastMessage?: boolean) => Promise<{ sessions: SessionListRow[] }>;
    queries: ReturnType<typeof trackSqliteStatementExecutions<"events">>;
  }) => Promise<void>,
) {
  await withOpenClawTestState({ label: "inventory-title-hydration" }, async (state) => {
    const storePath = path.join(state.sessionsDir(), "sessions.json");
    const rows = definitions.map(({ row }, index) => ({
      key: `agent:main:dashboard:inventory-${index}`,
      sessionId: `inventory-${index}`,
      agentId: "main",
      kind: "direct" as const,
      classification: "dashboard" as const,
      updatedAt: 1_000 - index,
      ...row,
    }));
    const scopes: Array<{
      agentId: string;
      storePath: string;
      sessionKey: string;
      sessionId: string;
    }> = [];
    for (const [index, definition] of definitions.entries()) {
      const row = rows[index]!;
      if (!definition.transcript || !row.sessionId) {
        continue;
      }
      const scope = { agentId: "main", storePath, sessionKey: row.key, sessionId: row.sessionId };
      scopes.push(scope);
      replaceSessionEntrySync(scope, {
        sessionId: row.sessionId,
        updatedAt: row.updatedAt ?? 0,
        label: row.label,
        displayName: row.displayName,
        subject: row.subject,
      });
      for (const message of [
        { role: "user", content: `Find inventory topic ${index}.` },
        {
          role: "assistant",
          content: `Preview ${index}. ${definition.transcript === "large" ? PAYLOAD_MARKER.repeat(3_000) : ""}`,
        },
      ]) {
        expect(appendTranscriptMessageSync(scope, { message }).ok).toBe(true);
      }
    }
    const persisted = () =>
      scopes.map((scope) => ({
        entry: loadSessionEntryReadOnly(scope),
        watermark: readSessionTranscriptWatermark(scope),
      }));
    const before = persisted();
    const callGateway: AgentToolGatewayRequestCaller = async <T>(
      request: Parameters<AgentToolGatewayRequestCaller>[0],
    ): Promise<T> => {
      expect(request.method).toBe("sessions.list");
      expect(request.params).toMatchObject({
        includeDerivedTitles: false,
        includeLastMessage: false,
      });
      return { path: storePath, sessions: rows } as T;
    };
    const tool = createSessionsListTool({
      config: VALID_CONFIG,
      agentSessionKey: "agent:main:main",
      callGateway,
    });
    const database = openOpenClawAgentDatabase({ agentId: "main" });
    const queries = trackSqliteStatementExecutions(database.db, ["events"], (sql) =>
      /^select\b[\s\S]*\bevent_json\b/i.test(sql) ? "events" : null,
    );
    try {
      await run({
        queries,
        render: async (includeLastMessage = false) =>
          (
            await tool.execute("inventory-titles", {
              includeDerivedTitles: true,
              includeLastMessage,
              limit: definitions.length,
            })
          ).details as { sessions: SessionListRow[] },
      });
    } finally {
      queries.restore();
    }
    expect(persisted()).toEqual(before);
  });
}

test("does not hydrate named tool rows while preserving projected titles and visibility", async () => {
  await withInventory(
    [
      { row: { label: " Explicit ", displayName: "Stored" }, transcript: "large" },
      { row: { displayName: " Projected display ", subject: "Subject" }, transcript: "large" },
      { row: { derivedTitle: "Gateway title", label: "Ignored" }, transcript: "large" },
      { row: { derivedTitle: " \t ", label: "Ignored" }, transcript: "large" },
      { row: { label: " ", displayName: " ", subject: " Subject title " }, transcript: "large" },
      { row: { label: " ", displayName: " ", subject: " " }, transcript: "small" },
      { row: { sessionId: undefined, label: "No identity" } },
      { row: { key: "agent:other:main", agentId: "other", derivedTitle: "Hidden agent" } },
      { row: { key: "agent:main:dashboard:incognito-hidden", derivedTitle: "Hidden incognito" } },
    ],
    async ({ render, queries }) => {
      const parse = vi.spyOn(JSON, "parse");
      try {
        const titles = await render();
        expect(titles.sessions.map((row) => row.derivedTitle)).toEqual([
          "Explicit",
          "Projected display",
          "Gateway title",
          " \t ",
          "Subject title",
          "Find inventory topic 5.",
          undefined,
        ]);
        expect(queries.textBytes.events).toBeGreaterThan(0);
        expect(queries.textBytes.events).toBeLessThan(4_096);
        expect(parse.mock.calls.some(([json]) => json.includes(PAYLOAD_MARKER))).toBe(false);
        const previews = await render(true);
        expect(queries.textBytes.events).toBeGreaterThan(PAYLOAD_MARKER.length * 3_000 * 5);
        expect(previews.sessions.slice(0, 6).every((row) => row.lastMessagePreview)).toBe(true);
        for (const row of previews.sessions) {
          delete row.lastMessagePreview;
        }
        expect(JSON.stringify(previews)).toBe(JSON.stringify(titles));
      } finally {
        parse.mockRestore();
      }
    },
  );
});

test("keeps the first 100 tool session identities when named titles skip hydration", async () => {
  await withInventory(
    [
      { row: { sessionId: undefined, label: "No identity" } },
      ...Array.from({ length: 99 }, (_, index) => ({ row: { label: `Named ${index}` } })),
      { row: {}, transcript: "small" },
      { row: {}, transcript: "small" },
    ],
    async ({ render }) => {
      const result = await render();
      expect(result.sessions).toHaveLength(102);
      expect(result.sessions[0]?.derivedTitle).toBeUndefined();
      expect(result.sessions[99]?.derivedTitle).toBe("Named 98");
      expect(result.sessions[100]?.derivedTitle).toBe("Find inventory topic 100.");
      expect(result.sessions[101]?.derivedTitle).toBeUndefined();
    },
  );
});
