import { renameSync } from "node:fs";
import { backup } from "node:sqlite";
import { asOptionalRecord, isRecord } from "@openclaw/normalization-core/record-coerce";
import { describe, expect, it, vi } from "vitest";
import { OpenClawAgentDatabaseReadOnlyScope } from "../../state/openclaw-agent-db-readonly-scope.js";
import {
  closeOpenClawAgentDatabasesAsync,
  openOpenClawAgentDatabase,
  runOpenClawAgentWriteTransaction,
} from "../../state/openclaw-agent-db.js";
import {
  appendTranscriptEvent,
  appendTranscriptEventSync,
  appendTranscriptMessage,
  appendTranscriptMessageSync,
  persistSessionTranscriptTurn,
  replaceSessionEntrySync,
  replaceTranscriptEvents,
  withTranscriptWriteTransaction,
} from "./session-accessor.js";
import {
  readRecentSessionTranscriptHistoryEvents,
  readSessionTranscriptHistoryEventPage,
} from "./session-accessor.sqlite-history-events.js";
import {
  historyEventId,
  useHistoryEventScope,
} from "./session-accessor.sqlite-history.test-support.js";
import { transcriptMessage } from "./transcript-message.test-support.js";

describe("SQLite transcript history cache", () => {
  const scope = useHistoryEventScope();
  const limits = { maxMessages: 20, maxLines: 20, maxBytes: 64 * 1024 };
  const read = () => readRecentSessionTranscriptHistoryEvents(scope, limits);
  const readHeadPage = () =>
    readSessionTranscriptHistoryEventPage(scope, {
      offset: 0,
      maxMessages: limits.maxMessages,
      recentAtHead: limits,
    });

  async function seedRoot() {
    replaceSessionEntrySync(scope, { sessionId: scope.sessionId, updatedAt: Date.now() });
    await persistSessionTranscriptTurn(scope, {
      messages: [transcriptMessage("root", null, { role: "user", content: "root" })],
      touchSessionEntry: false,
    });
  }

  it("reuses recent payloads with fresh result ownership until append or rewrite", async () => {
    const events = [
      { type: "session", version: 3, id: scope.sessionId },
      {
        type: "message",
        id: "original",
        parentId: null,
        message: {
          role: "user",
          content: [{ type: "text", text: "cache-window-original" }],
        },
      },
      {
        type: "message",
        id: "initial",
        parentId: "original",
        message: { role: "assistant", content: "reply" },
      },
    ];
    await replaceTranscriptEvents(scope, events);
    const first = read();
    const parse = vi.spyOn(JSON, "parse");
    const second = read();
    expect(parse.mock.calls.filter(([json]) => json.includes("cache-window-original"))).toEqual([]);
    parse.mockRestore();
    for (const page of [first, second]) {
      const message = asOptionalRecord(page.events[0]?.event)?.message;
      if (!isRecord(message) || !Array.isArray(message.content) || !isRecord(message.content[0])) {
        throw new Error("expected the original message content");
      }
      message.content[0].text = "caller mutation";
      expect(asOptionalRecord(read().events[0]?.event)?.message).toEqual(events[1]?.message);
    }
    await persistSessionTranscriptTurn(scope, {
      messages: [transcriptMessage("appended", "initial", { role: "user", content: "next" })],
      touchSessionEntry: false,
    });
    expect(read().events.map(historyEventId)).toEqual(["original", "initial", "appended"]);
    const replacement = [
      ...events,
      {
        type: "message",
        id: "appended",
        parentId: "initial",
        message: { role: "user", content: "rewritten" },
      },
    ];
    await replaceTranscriptEvents(scope, replacement);
    expect(asOptionalRecord(read().events.at(-1)?.event)?.message).toEqual(
      replacement.at(-1)?.message,
    );
    expect(
      readRecentSessionTranscriptHistoryEvents(scope, { ...limits, maxMessages: 1 }).events.map(
        historyEventId,
      ),
    ).toEqual(["appended"]);
  });

  it.each(["commit", "rollback", "savepoint rollback"] as const)(
    "retains only committed recent windows after a nested writer %s",
    async (outcome) => {
      await seedRoot();
      expect(read().events.map(historyEventId)).toEqual(["root"]);
      const appendPending = () => {
        expect(
          appendTranscriptMessageSync(
            scope,
            transcriptMessage("pending", "root", { role: "user", content: "pending" }),
          ),
        ).toMatchObject({ ok: true, value: { appended: true } });
        const page = read();
        expect(page.events.map(historyEventId)).toEqual(["root", "pending"]);
        const message = asOptionalRecord(page.events.at(-1)?.event)?.message;
        if (!isRecord(message)) {
          throw new Error("expected pending message");
        }
        message.content = "caller mutation before commit";
        page.events.length = 0;
        if (outcome !== "commit") {
          throw new Error("rollback pending history");
        }
      };
      const transaction = withTranscriptWriteTransaction(scope, () => {
        if (outcome !== "savepoint rollback") {
          appendPending();
          return;
        }
        expect(() =>
          runOpenClawAgentWriteTransaction(appendPending, {
            agentId: scope.agentId,
            env: scope.env,
          }),
        ).toThrow("rollback pending history");
        expect(
          appendTranscriptMessageSync(
            scope,
            transcriptMessage("committed", "root", { role: "user", content: "committed" }),
          ),
        ).toMatchObject({ ok: true, value: { appended: true } });
      });
      if (outcome === "rollback") {
        await expect(transaction).rejects.toThrow("rollback pending history");
        // Reuse the rolled-back physical sequence before any intervening history read.
        await persistSessionTranscriptTurn(scope, {
          messages: [
            transcriptMessage("committed", "root", { role: "user", content: "committed" }),
          ],
          touchSessionEntry: false,
        });
      } else {
        await transaction;
      }
      const expected = outcome === "commit" ? "pending" : "committed";
      const page = read();
      expect(page.events.map(historyEventId)).toEqual(["root", expected]);
      expect(asOptionalRecord(page.events.at(-1)?.event)?.message).toMatchObject({
        content: expected,
      });
    },
  );

  it("does not retain a rolled-back reset in uncached history pages", async () => {
    await seedRoot();
    const initial = readHeadPage();
    await expect(
      withTranscriptWriteTransaction(scope, () => {
        expect(
          appendTranscriptEventSync(scope, {
            type: "reset",
            id: "pending-reset",
            parentId: "root",
            reason: "new",
          }),
        ).toMatchObject({ ok: true, value: true });
        expect(readHeadPage().events.map(historyEventId)).toEqual(["pending-reset"]);
        throw new Error("rollback reset");
      }),
    ).rejects.toThrow("rollback reset");
    await appendTranscriptMessage(
      scope,
      transcriptMessage("committed", "root", { role: "user", content: "committed" }),
    );
    const page = readHeadPage();
    expect(page.displaySource).toBe(initial.displaySource);
    expect(page.totalMessages).toBe(2);
    expect(page.events.map(historyEventId)).toEqual(["root", "committed"]);
    expect(page.events.map((row) => row.seq)).toEqual([1, 2]);
  });

  it("invalidates reset windows when a backup fork replaces the physical database", async () => {
    await seedRoot();
    const database = openOpenClawAgentDatabase({ agentId: scope.agentId, env: scope.env });
    const replacementPath = `${database.path}.replacement.sqlite`;
    await backup(database.db, replacementPath);
    await appendTranscriptEvent(scope, {
      type: "reset",
      id: "old-reset",
      parentId: "root",
      reason: "new",
    });
    await appendTranscriptMessage(
      { ...scope, storePath: replacementPath },
      transcriptMessage("replacement", "root", { role: "user", content: "replacement" }),
    );
    await closeOpenClawAgentDatabasesAsync(scope.env.OPENCLAW_STATE_DIR);
    const readerScope = new OpenClawAgentDatabaseReadOnlyScope();
    const target = { agentId: scope.agentId, path: database.path };
    const readOnly = () =>
      readerScope.run(target, () =>
        readRecentSessionTranscriptHistoryEvents(
          { ...scope, storePath: database.path },
          { ...limits, readOnly: true },
        ),
      );
    try {
      const original = readOnly();
      expect(original.events.map(historyEventId)).toEqual(["old-reset"]);
      // Close before renaming so the same replacement proof runs on Windows.
      readerScope.close();
      renameSync(database.path, `${database.path}.previous`);
      renameSync(replacementPath, database.path);
      const replaced = readOnly();
      expect(replaced.displaySource).toBe(original.displaySource);
      expect(replaced.deltaCursor).toBe(original.deltaCursor);
      expect(replaced.totalMessages).toBe(2);
      expect(replaced.events.map(historyEventId)).toEqual(["root", "replacement"]);
      expect(replaced.events.map((row) => row.seq)).toEqual([1, 2]);
    } finally {
      readerScope.close();
    }
  });
});
