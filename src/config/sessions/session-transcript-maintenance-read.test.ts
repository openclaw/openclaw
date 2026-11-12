import assert from "node:assert/strict";
import { serialize } from "node:v8";
import { expect, it, vi } from "vitest";
import { trackSqliteStatementExecutions } from "../../../test/helpers/sqlite-statement-execution-counter.js";
import { makeUserMessage } from "../../../test/helpers/user-message.js";
import {
  bindCodeModeSessionStore,
  createCodeModeSessionStoreAccess,
  disposeCodeModeSessionStore,
} from "../../agents/code-mode-session-store.js";
import { withSessionState } from "../../agents/sessions/session-manager-fixtures.test-support.js";
import { withSelectedTranscriptReader } from "../../agents/sessions/session-manager-reader.test-support.js";
import { SessionManager } from "../../agents/sessions/session-manager.js";
import type { ToolSearchCatalogRef } from "../../agents/tool-search-types.js";
import { executeSqliteQuerySync } from "../../infra/kysely-sync.js";
import { createNestedToolActivity } from "../../sessions/nested-tool-activity.js";
import { openOpenClawAgentDatabase } from "../../state/openclaw-agent-db.js";
import { requireNativeSqliteDatabase } from "../../test-utils/native-sqlite.js";
import { getSessionKysely } from "./session-accessor.sqlite-scope.js";
import { readActiveTranscriptEntryAnchor } from "./session-accessor.sqlite-transcript-admitted-read.js";
import { replaceTranscriptEvents } from "./session-accessor.sqlite-transcript-write.test-support.js";
import * as hydration from "./session-transcript-hydration.js";
import type {
  SessionTranscriptMaintenanceCheckpoint,
  SessionTranscriptMaintenanceFacts,
} from "./session-transcript-hydration.types.js";
import { readSessionTranscriptMaintenance } from "./session-transcript-maintenance-read.js";
import { runWithSessionTranscriptReadFence } from "./session-transcript-read-fence.js";
import { messageEvent } from "./transcript-message.test-support.js";
import { createTranscriptPayloadUpdater, prepareTranscriptPayload } from "./transcript-payload.js";

const customType = "openclaw.code-mode-store";
const storeWrite = (value: unknown) => ({
  set: { key: value },
  delete: [],
  networkContent: { key: true },
});

function nestedActivity(id: string, scopeId = "attempt") {
  return messageEvent(
    id,
    null,
    createNestedToolActivity({
      runId: "run",
      scopeId,
      afterEntryId: null,
      startOrder: 0,
      toolCallId: id,
      toolName: "lookup",
      input: {},
      result: { content: [{ type: "text", text: "accepted evidence ".repeat(256) }] },
      isError: false,
      startedAt: 1,
      timestamp: 2,
    }),
  );
}

it("reads only nested activity candidates while preserving selected corruption failures", () =>
  withSessionState("nested-maintenance-selection", async ({ scope }) => {
    const first = nestedActivity("first");
    const last = nestedActivity("last");
    await replaceTranscriptEvents(scope, [
      { type: "session", id: scope.sessionId, version: 3 },
      first,
      messageEvent("unrelated", "first", {
        role: "toolResult",
        content: [{ type: "text", text: "unrelated body ".repeat(16 * 1024) }],
      }),
      nestedActivity("other-scope", "other"),
      last,
    ]);
    const database = openOpenClawAgentDatabase({ agentId: scope.agentId, path: scope.storePath });
    const db = getSessionKysely(database.db);
    const read = () =>
      readSessionTranscriptMaintenance(database, scope, {
        operation: "nested-activity",
        scopeId: "attempt",
        firstEntryId: "first",
        lastEntryId: "last",
      }).events;
    const reads = trackSqliteStatementExecutions(
      requireNativeSqliteDatabase(database.db),
      ["transcript"],
      (sql) => (/\btranscript_events\b/i.test(sql) ? "transcript" : null),
    );
    try {
      expect(read()).toEqual([first, last]);
      expect(reads.textBytes.transcript).toBeLessThan(32 * 1024);
      const corrupt = (seq: number) =>
        executeSqliteQuerySync(
          database.db,
          db
            .updateTable("transcript_events")
            .set({ event_zstd: Buffer.from([1, 2, 3]) })
            .where("session_id", "=", scope.sessionId)
            .where("seq", "=", seq)
            .where("event_json", "is", null)
            .returning("seq"),
        ).rows;
      expect(corrupt(2)).toEqual([{ seq: 2 }]);
      expect(read()).toEqual([first, last]);
      expect(corrupt(4)).toEqual([{ seq: 4 }]);
      expect(read).toThrow();
    } finally {
      reads.restore();
    }
  }));

it.each(["message", "type", "customType", "inline", "role"] as const)(
  "preserves nested evidence across %s envelopes",
  (kind) =>
    withSessionState(`nested-maintenance-${kind}`, async ({ scope }) => {
      const first = nestedActivity("first");
      const middle = nestedActivity("middle");
      const last = nestedActivity("last");
      await replaceTranscriptEvents(scope, [
        { type: "session", id: scope.sessionId, version: 3 },
        first,
        middle,
        last,
      ]);
      const database = openOpenClawAgentDatabase({ agentId: scope.agentId, path: scope.storePath });
      let raw = JSON.stringify(middle);
      if (kind === "message") {
        raw = raw.replace(
          '"message":',
          '"message":{"role":"user","customType":"other"},"message":',
        );
      } else if (kind === "type") {
        raw = raw.replace('"type":"message"', '"type":"custom","type":"message"');
      } else if (kind === "customType") {
        raw = raw.replace('"customType":', '"customType":"other","customType":');
      } else if (kind === "role") {
        raw = raw.replace('"role":"custom"', '"role":"user"');
      }
      const payload = prepareTranscriptPayload(database.db, raw);
      if (kind === "inline") {
        payload.event_json = raw;
        payload.event_zstd = null;
        payload.navigation_json = null;
      } else {
        expect(payload.event_json).toBeNull();
      }
      createTranscriptPayloadUpdater(database.db, scope.sessionId)({ ...payload, seq: 2 });
      const result = readSessionTranscriptMaintenance(database, scope, {
        operation: "nested-activity",
        scopeId: "attempt",
        firstEntryId: "first",
        lastEntryId: "last",
      });
      expect(result.events).toEqual([first, JSON.parse(raw), last]);
    }),
);

function checkpoint(result: SessionTranscriptMaintenanceFacts, leafEntryId: string | null) {
  assert(result.version?.generation && result.version.rawSeq !== null);
  return {
    generation: result.version.generation,
    rawSeq: result.version.rawSeq,
    leafEntryId,
  } satisfies SessionTranscriptMaintenanceCheckpoint;
}

it("returns compact Code Mode replay across new turns instead of retransferring historical values", () =>
  withSessionState("maintenance-reply", async ({ scope }) => {
    const manager = await SessionManager.openAsync(scope);
    for (let index = 0; index < 16; index++) {
      await manager.appendCustomEntryAsync(
        customType,
        storeWrite(`${index}:` + "x".repeat(32 * 1024)),
      );
    }
    await manager.appendCustomEntryAsync(customType, storeWrite("kept"));
    const replyBytes: number[] = [];
    const prepare = hydration.prepareSessionTranscriptHydration;
    const observe = vi
      .spyOn(hydration, "prepareSessionTranscriptHydration")
      .mockImplementation((...args) => {
        const reader = prepare(...args);
        return {
          ...reader,
          async readMaintenance(request) {
            const result = await reader.readMaintenance(request);
            replyBytes.push(serialize(result).byteLength);
            return result;
          },
        };
      });
    const load = () =>
      withSelectedTranscriptReader(
        scope,
        async () => {
          const owner: ToolSearchCatalogRef = {
            current: {
              entries: [],
              counterScope: "maintenance",
              searchCount: 0,
              describeCount: 0,
              callCount: 0,
            },
          };
          bindCodeModeSessionStore(owner, manager);
          const cell = createCodeModeSessionStoreAccess(
            { catalogRef: owner, sessionId: scope.sessionId, runId: "maintenance" },
            new AbortController().signal,
          );
          try {
            return await cell.load("key");
          } finally {
            cell.close();
            owner.current = undefined;
            disposeCodeModeSessionStore(owner);
          }
        },
        true,
      );
    try {
      await expect(load()).resolves.toEqual({ value: "kept", networkContent: true });
      await manager.appendMessageAsync(makeUserMessage("Cron-style next turn", 1));
      await expect(load()).resolves.toEqual({ value: "kept", networkContent: true });
      await manager.appendCustomEntryAsync(customType, storeWrite("changed"));
      await expect(load()).resolves.toEqual({ value: "changed", networkContent: true });
      expect(replyBytes).toHaveLength(3);
      expect(Math.max(...replyBytes)).toBeLessThan(2048);
    } finally {
      observe.mockRestore();
    }
  }));

it("reads only append work and rejects later checkpoints across branches and admission fences", () =>
  withSessionState("maintenance-checkpoint", async ({ scope }) => {
    const manager = await SessionManager.openAsync(scope);
    for (let index = 0; index < 16; index++) {
      await manager.appendCustomEntryAsync(
        customType,
        storeWrite(`${index}:` + "x".repeat(32 * 1024)),
      );
    }
    const oldLeaf = await manager.appendCustomEntryAsync(
      customType,
      storeWrite("before admission"),
    );
    const database = openOpenClawAgentDatabase({ agentId: scope.agentId, path: scope.storePath });
    const read = (leafEntryId: string | null, previous?: SessionTranscriptMaintenanceCheckpoint) =>
      readSessionTranscriptMaintenance(database, scope, {
        operation: "code-mode-store",
        leafEntryId,
        checkpoint: previous,
      });
    const first = read(oldLeaf);
    expect(first.store?.writes.get("key")).toEqual({
      value: "before admission",
      networkContent: true,
    });
    const saved = checkpoint(first, oldLeaf);
    const reads = trackSqliteStatementExecutions(
      requireNativeSqliteDatabase(database.db),
      ["transcript"],
      (sql) => (/\btranscript_events\b/i.test(sql) ? "transcript" : null),
    );
    try {
      expect(read(oldLeaf, saved).store).toEqual({ writes: new Map(), incremental: true });
      expect(reads.textBytes.transcript).toBeLessThan(512);
      const user = await manager.appendMessageAsync(makeUserMessage("Current request", 2));
      assert(user);
      reads.textBytes.transcript = 0;
      const afterMessage = read(user, saved);
      expect(afterMessage.store).toEqual({ writes: new Map(), incremental: true });
      expect(reads.textBytes.transcript).toBeLessThan(2048);
      const anchor = readActiveTranscriptEntryAnchor({ ...scope, entryId: user });
      assert(anchor);
      const futureLeaf = await manager.appendCustomEntryAsync(
        customType,
        storeWrite("after admission"),
      );
      const future = read(futureLeaf, checkpoint(afterMessage, user));
      expect(future.store).toEqual({
        writes: new Map([["key", { value: "after admission", networkContent: true }]]),
        incremental: true,
      });
      const fenced = runWithSessionTranscriptReadFence(
        { ...anchor, role: "user", logicalTurnId: "current" },
        () => read(oldLeaf, checkpoint(future, futureLeaf)),
      );
      expect(fenced.store).toEqual({
        writes: new Map([["key", { value: "before admission", networkContent: true }]]),
        incremental: false,
      });
      expect(fenced.version?.rawSeq).toBe(anchor.rawSeq - 1);
      expect(read(futureLeaf, checkpoint(fenced, oldLeaf)).store?.writes.get("key")).toEqual({
        value: "after admission",
        networkContent: true,
      });
      await manager.branchAsync(oldLeaf);
      const branchLeaf = await manager.appendCustomEntryAsync(customType, {
        set: { branch: "selected" },
        delete: [],
        networkContent: { branch: false },
      });
      const branch = read(branchLeaf, checkpoint(future, futureLeaf));
      expect(branch.store).toEqual({
        writes: new Map([
          ["key", { value: "before admission", networkContent: true }],
          ["branch", { value: "selected", networkContent: false }],
        ]),
        incremental: false,
      });
      for (let index = 0; index < 257; index++) {
        await manager.appendMessageAsync(makeUserMessage(`Unobserved turn ${index}`, index + 3));
      }
      const latestLeaf = await manager.appendCustomEntryAsync(
        customType,
        storeWrite("after long suffix"),
      );
      const exhausted = read(latestLeaf, checkpoint(branch, branchLeaf));
      expect(exhausted.store).toEqual({
        writes: new Map([
          ["key", { value: "after long suffix", networkContent: true }],
          ["branch", { value: "selected", networkContent: false }],
        ]),
        incremental: false,
      });
      await manager.appendLeafControlAsync({
        targetId: latestLeaf,
        appendParentId: oldLeaf,
        appendMode: "side",
      });
      expect(read(latestLeaf, checkpoint(exhausted, latestLeaf)).store).toEqual(exhausted.store);
    } finally {
      reads.restore();
    }
  }));
