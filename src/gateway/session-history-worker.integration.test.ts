import { channel } from "node:diagnostics_channel";
import path from "node:path";
import type { DatabaseSync, StatementSync } from "node:sqlite";
import { expect, it, vi } from "vitest";
import { readMainSessionRecoveryCheckpoint } from "../agents/main-session-recovery/main-session-restart-recovery-checkpoint.js";
import {
  appendTranscriptEvent,
  appendTranscriptMessage,
  replaceSessionEntry,
  replaceTranscriptEvents,
  waitForSessionTranscriptProjection,
} from "../config/sessions/session-accessor.js";
import { readTranscriptDisplayDelta } from "../config/sessions/session-accessor.sqlite-history-events.js";
import { readActiveTranscriptEntryAnchor } from "../config/sessions/session-accessor.sqlite-transcript-anchor.js";
import { readSessionColdTranscript } from "../config/sessions/session-cold-storage-state.js";
import { runSessionColdStorageMaintenance } from "../config/sessions/session-cold-storage.js";
import {
  createSessionColdStorageFixture,
  currentId,
  historicalId,
  maintenanceConfig,
} from "../config/sessions/session-cold-storage.test-support.js";
import { readSessionHistoryPageInWorker } from "../config/sessions/session-history-worker-runtime.js";
import { runWithSessionTranscriptReadFence } from "../config/sessions/session-transcript-read-fence.js";
import { openOpenClawAgentDatabase } from "../state/openclaw-agent-db.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { readChatHistoryPage } from "./server-methods/chat-history-pages.js";
import { readSessionHistorySnapshotAsync } from "./session-history-state.js";
import { readChatHistoryMessageId } from "./session-history-tail.js";
import { readSessionPreviewItemsFromTranscriptAsync } from "./session-transcript-preview.js";
import {
  readSessionMessageByIdAsync,
  readSessionTranscriptSummaryAsync,
} from "./session-transcript-readers.js";
import { readLatestSessionUsageFromTranscriptAsync } from "./session-transcript-usage.js";

function historyParams(
  target: { agentId: string; sessionId: string; sessionKey: string; storePath: string },
  entry?: { sessionId: string; updatedAt: number },
) {
  return {
    entry,
    provider: undefined,
    sessionId: target.sessionId,
    storePath: target.storePath,
    sessionAgentId: target.agentId,
    canonicalKey: target.sessionKey,
    max: 10,
    maxHistoryBytes: 100_000,
    effectiveMaxChars: 8000,
    offset: undefined,
    messageId: undefined,
  };
}

function observeColdMetadataReads(database: DatabaseSync) {
  const prototype: StatementSync = Object.getPrototypeOf(database.prepare("SELECT 1"));
  const metadataReads: string[] = [];
  const record = (sql: string) => {
    if (
      /^select\b.*\bfrom\s+["`]?session_transcript_cold_archives["`]?/is.test(sql) &&
      sql.includes("archive_sha256")
    ) {
      metadataReads.push(sql);
    }
  };
  const observers = (["all", "get", "iterate", "run"] as const).map((method) => {
    const original = prototype[method];
    return vi.spyOn(prototype, method).mockImplementation(
      new Proxy(original, {
        apply(read, receiver: StatementSync, args) {
          record(receiver.sourceSQL);
          return Reflect.apply(read, receiver, args);
        },
      }),
    );
  });
  return {
    metadataReads,
    restore: () => observers.forEach((observer) => observer.mockRestore()),
  };
}

it.each(["rpc", "message-by-id"] as const)(
  "restores %s history without reading cold metadata on the caller",
  async (transport) => {
    await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
      const fixture = await createSessionColdStorageFixture(state.statePath("cold-history.sqlite"));
      expect(
        await runSessionColdStorageMaintenance({
          config: maintenanceConfig(fixture.scope.storePath),
        }),
      ).toEqual({ archivedTranscripts: 1, externalizedTranscripts: 0 });
      const { metadataReads, restore } = observeColdMetadataReads(fixture.database());
      try {
        expect(readSessionColdTranscript(fixture.database(), historicalId)).toBeDefined();
        expect(metadataReads).toHaveLength(1);
        metadataReads.length = 0;
        const read = async () => {
          if (transport === "message-by-id") {
            const result = await readSessionMessageByIdAsync(fixture.scope, "history-assistant");
            expect(result).toMatchObject({ found: true, oversized: false, seq: 2 });
            return [readChatHistoryMessageId(result.message)];
          }
          const page = await readChatHistoryPage(historyParams(fixture.scope));
          return page.messages.map(readChatHistoryMessageId);
        };
        // The first read restores cold history; the second probes the now-hot transcript.
        for (let round = 0; round < 2; round++) {
          expect(await read()).toEqual(
            transport === "message-by-id"
              ? ["history-assistant"]
              : ["history-user", "history-assistant"],
          );
          expect(metadataReads).toEqual([]);
        }
      } finally {
        restore();
      }
      expect(readSessionColdTranscript(fixture.database(), historicalId)).toBeUndefined();
      expect(fixture.snapshot()).toEqual(fixture.original);
    });
  },
);

it("appends hot transcript events without reading cold metadata on the caller", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
    const fixture = await createSessionColdStorageFixture(state.statePath("hot-write.sqlite"));
    const target = { ...fixture.scope, sessionId: currentId };
    await waitForSessionTranscriptProjection(target);
    const { metadataReads, restore } = observeColdMetadataReads(fixture.database());
    try {
      expect(readSessionColdTranscript(fixture.database(), currentId)).toBeUndefined();
      expect(metadataReads).toHaveLength(1);
      metadataReads.length = 0;
      await appendTranscriptMessage(target, {
        eventId: "hot-append",
        parentId: null,
        message: { role: "user", content: "A hot append keeps its own write owner" },
      });
      await waitForSessionTranscriptProjection(target);
      expect(metadataReads).toEqual([]);
      expect(fixture.snapshot().events).toContainEqual(
        expect.objectContaining({
          session_id: currentId,
          event_json: expect.stringContaining('"id":"hot-append"'),
        }),
      );
    } finally {
      restore();
    }
  });
});

it("validates worker admission for normalized logical inputs in a shared store", async () => {
  const input = { agentId: "Other", sessionKey: "Agent:Other:Fenced-History" };
  await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
    const database = openOpenClawAgentDatabase({
      agentId: "main",
      env: state.env,
      path: state.statePath("shared-history.sqlite"),
    });
    const target = {
      agentId: "other",
      sessionKey: "agent:other:fenced-history",
      sessionId: "requested-fenced-history",
      storePath: database.path,
    };
    const entry = { sessionId: target.sessionId, updatedAt: 1 };
    await replaceSessionEntry(target, entry);
    await replaceTranscriptEvents(target, [
      { type: "session", version: 3, id: target.sessionId },
      {
        type: "message",
        id: "before",
        parentId: null,
        message: { role: "user", content: "Visible requested history" },
      },
      {
        type: "message",
        id: "admitted",
        parentId: "before",
        message: { role: "user", content: "Current turn" },
      },
      {
        type: "message",
        id: "later",
        parentId: "admitted",
        message: { role: "assistant", content: "After the admitted boundary" },
      },
    ]);
    await waitForSessionTranscriptProjection(target);
    const anchor = readActiveTranscriptEntryAnchor({ ...target, entryId: "admitted" });
    if (!anchor) {
      throw new Error("expected current-turn transcript anchor");
    }
    expect(anchor).toMatchObject({
      agentId: target.agentId,
      sessionId: target.sessionId,
      sessionKey: target.sessionKey,
      storePath: database.path,
    });
    expect(database.agentId).toBe("main");
    const admission = { ...anchor, logicalTurnId: "worker-fence", role: "user" as const };
    const readRpc = () => readChatHistoryPage(historyParams({ ...target, ...input }, entry));
    const readHttp = () =>
      readSessionHistorySnapshotAsync({
        target: { ...target, ...input, sessionEntry: entry },
        limit: 10,
      });
    const page = await runWithSessionTranscriptReadFence(admission, readRpc);
    expect(page.messages.map(readChatHistoryMessageId)).toEqual(["before", "admitted", "later"]);
    const http = await runWithSessionTranscriptReadFence(admission, readHttp);
    expect(http.history.messages.map(readChatHistoryMessageId)).toEqual([
      "before",
      "admitted",
      "later",
    ]);
    expect(http.transcriptPath).toBe(input.sessionKey);
    // Display rows remain visible, but normalization must not lose admission validation.
    const invalidAdmission = { ...admission, storePath: `${database.path}.other` };
    await expect(runWithSessionTranscriptReadFence(invalidAdmission, readRpc)).rejects.toThrow(
      "different transcript store",
    );
    await expect(runWithSessionTranscriptReadFence(invalidAdmission, readHttp)).rejects.toThrow(
      "different transcript store",
    );
    for (const sessionKey of [input.sessionKey, "fenced-history"]) {
      const readPreview = () =>
        readSessionPreviewItemsFromTranscriptAsync({ ...target, ...input, sessionKey }, 10, 160);
      expect(await runWithSessionTranscriptReadFence(admission, readPreview)).toEqual([
        { role: "user", text: "Visible requested history" },
        { role: "user", text: "Current turn" },
        { role: "assistant", text: "After the admitted boundary" },
      ]);
      await expect(
        runWithSessionTranscriptReadFence(invalidAdmission, readPreview),
      ).rejects.toThrow("different transcript store");
    }
  });
});

it("reads a sparse page in the transcript worker", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
    const target = {
      agentId: "main",
      sessionId: "worker-sparse-history",
      sessionKey: "agent:main:worker-sparse-history",
      storePath: path.join(state.sessionsDir(), "sessions.json"),
    };
    const entry = { sessionId: target.sessionId, updatedAt: 1 };
    await replaceSessionEntry(target, entry);
    const ids = Array.from({ length: 252 }, (_, index) => `row-${index}`);
    await replaceTranscriptEvents(target, [
      { type: "session", version: 3, id: target.sessionId },
      ...ids.map((id, index) => ({
        type: "message",
        id,
        parentId: ids[index - 1] ?? null,
        message:
          index === 0
            ? { role: "user", content: "Question before silent activity" }
            : {
                role: "assistant",
                content: index === ids.length - 1 ? "Visible final answer" : "NO_REPLY",
              },
      })),
    ]);
    await waitForSessionTranscriptProjection(target);
    const params = { ...historyParams(target, entry), max: 2 };
    const diagnostics = channel("openclaw.worker.task");
    const tasks: unknown[] = [];
    const record = (value: unknown) => {
      if (
        typeof value === "object" &&
        value !== null &&
        "worker" in value &&
        typeof value.worker === "string" &&
        value.worker.startsWith("session-transcript.worker")
      ) {
        tasks.push(value);
      }
    };
    diagnostics.subscribe(record);
    try {
      const page = await readChatHistoryPage(params);
      expect(page.messages.map(readChatHistoryMessageId)).toEqual([ids[0], ids.at(-1)]);
      expect(page.pagination).toMatchObject({ totalMessages: 252, rawPageMessages: 252 });
      expect(tasks.length).toBeGreaterThan(0);
    } finally {
      diagnostics.unsubscribe(record);
    }

    const http = await readSessionHistorySnapshotAsync({
      target: { ...target, sessionEntry: entry },
      limit: 2,
    });
    expect(http.history.items).toBe(http.history.messages);
    expect(http.history.messages.map(readChatHistoryMessageId)).toEqual([ids[0], ids.at(-1)]);
    expect(http.history.hasMore).toBe(false);
    expect(http.rawTranscriptSeq).toBe(252);

    const anchored = await readChatHistoryPage({ ...params, messageId: ids[0] });
    expect(anchored.messages.map(readChatHistoryMessageId)).toEqual([ids[0]]);
  });
});

it("waits for a missing projection and serves the original history request", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
    const target = {
      agentId: "main",
      sessionId: "worker-history-rebuild",
      sessionKey: "agent:main:worker-history-rebuild",
      storePath: path.join(state.sessionsDir(), "sessions.json"),
    };
    const entry = { sessionId: target.sessionId, updatedAt: 1 };
    await replaceSessionEntry(target, entry);
    await replaceTranscriptEvents(target, [
      { type: "session", version: 3, id: target.sessionId },
      { type: "message", id: "recovered", message: { role: "user", content: "Still here" } },
    ]);
    await waitForSessionTranscriptProjection(target);
    openOpenClawAgentDatabase({ agentId: target.agentId, env: state.env })
      .db.prepare(
        "UPDATE session_transcript_index_state SET needs_rebuild = 1 WHERE session_id = ?",
      )
      .run(target.sessionId);

    // Runtime tests own the recovery deadline; real worker startup must not spend it here.
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      const page = await readChatHistoryPage(historyParams(target, entry));
      expect(page.messages.map(readChatHistoryMessageId)).toEqual(["recovered"]);
    } finally {
      vi.useRealTimers();
    }
  });
});

it("reads a new branch and reset interval after earlier worker pages settle", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
    const target = {
      agentId: "main",
      sessionId: "worker-history-branch",
      sessionKey: "agent:main:worker-history-branch",
      storePath: path.join(state.sessionsDir(), "sessions.json"),
    };
    const entry = { sessionId: target.sessionId, updatedAt: 1 };
    await replaceSessionEntry(target, entry);
    await replaceTranscriptEvents(target, [
      { type: "session", version: 3, id: target.sessionId },
      { type: "message", id: "A", parentId: null, message: { role: "user", content: "Branch A" } },
      { type: "message", id: "B", parentId: null, message: { role: "user", content: "Branch B" } },
      { type: "leaf", id: "select-A", parentId: "B", targetId: "A", appendParentId: "A" },
    ]);
    await waitForSessionTranscriptProjection(target);
    const read = () =>
      readSessionHistorySnapshotAsync({ target: { ...target, sessionEntry: entry }, limit: 10 });
    const readDelta = async (cursor?: string) => {
      const scope = { ...target, sessionEntry: entry };
      const limits = { cursor, maxBytes: 1_000_000, maxEvents: 200 };
      const golden = readTranscriptDisplayDelta(scope, limits);
      const { delta } = await readSessionHistoryPageInWorker({
        kind: "delta",
        params: { target: scope, limits },
      });
      expect(JSON.stringify(delta)).toBe(JSON.stringify(golden));
      return delta.kind === "page" ? delta.cursor : undefined;
    };
    const beforeBranch = await readDelta();
    expect((await read()).history.messages.map(readChatHistoryMessageId)).toEqual(["A"]);
    await appendTranscriptEvent(target, {
      type: "leaf",
      id: "select-B",
      parentId: "A",
      targetId: "B",
      appendParentId: "B",
    });
    await waitForSessionTranscriptProjection(target);
    const beforeReset = await readDelta(beforeBranch);
    expect((await read()).history.messages.map(readChatHistoryMessageId)).toEqual(["B"]);
    await appendTranscriptEvent(target, {
      type: "reset",
      id: "reset-B",
      parentId: "B",
      reason: "new",
      timestamp: "2026-09-13T00:00:00.000Z",
    });
    await waitForSessionTranscriptProjection(target);
    await readDelta(beforeReset);
    const reset = await read();
    expect(reset.history.messages.map(readChatHistoryMessageId)).toEqual(["reset-B"]);
    expect(reset.rawTranscriptSeq).toBe(1);
  });
});

it("reduces full transcript recovery, usage, and MCP facts without caller-thread SQLite scans", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
    const target = {
      agentId: "main",
      sessionId: "worker-summary",
      sessionKey: "agent:main:worker-summary",
      storePath: state.statePath("summary.sqlite"),
    };
    await replaceSessionEntry(target, { sessionId: target.sessionId, updatedAt: 1 });
    const messages = [
      { role: "user", content: "Continue safely", provenance: { kind: "external_user" } },
      {
        role: "toolResult",
        toolName: "exec",
        content: [
          { type: "text", text: JSON.stringify({ status: "completed", replaySafe: true }) },
        ],
      },
      {
        role: "assistant",
        content: [
          { type: "toolCall", id: "app-call", name: "demo__show", arguments: { city: "Paris" } },
        ],
      },
      {
        role: "toolResult",
        toolCallId: "app-call",
        toolName: "demo__show",
        content: [{ type: "text", text: "ok" }],
        details: {
          mcpServer: "demo",
          mcpTool: "show",
          mcpAppPreview: {
            mcpApp: {
              viewId: "mcp-app-summary",
              serverName: "demo",
              toolName: "show",
              toolCallId: "app-call",
              uiResourceUri: "ui://demo/app",
            },
          },
        },
      },
      ...Array.from({ length: 1200 }, () => ({
        role: "assistant",
        content: "x".repeat(1024),
        provider: "test-provider",
        model: "test-model",
        usage: { input: 2, output: 1 },
      })),
    ];
    await replaceTranscriptEvents(target, [
      { type: "session", version: 3, id: target.sessionId },
      ...messages.map((message, index) => ({
        type: "message",
        id: `summary-${index}`,
        parentId: index ? `summary-${index - 1}` : null,
        message,
      })),
    ]);
    await waitForSessionTranscriptProjection(target);
    const { db } = openOpenClawAgentDatabase({ agentId: target.agentId, path: target.storePath });
    const prototype: StatementSync = Object.getPrototypeOf(db.prepare("SELECT 1"));
    const scans: string[] = [];
    const observers = (["all", "get", "iterate", "run"] as const).map((method) => {
      const original = prototype[method];
      return vi.spyOn(prototype, method).mockImplementation(
        new Proxy(original, {
          apply(read, receiver: StatementSync, args) {
            if (
              /\b(?:transcript_events|session_transcript_active_events)\b/iu.test(
                receiver.sourceSQL,
              )
            ) {
              scans.push(receiver.sourceSQL);
            }
            return Reflect.apply(read, receiver, args);
          },
        }),
      );
    });
    try {
      expect(await readMainSessionRecoveryCheckpoint(target)).toEqual({
        replaySafe: true,
        source: "external_user",
      });
      expect(scans).toEqual([]);
      expect(await readLatestSessionUsageFromTranscriptAsync(target)).toMatchObject({
        inputTokens: 2400,
        outputTokens: 1200,
      });
      expect(scans).toEqual([]);
      expect(
        await readSessionTranscriptSummaryAsync(target, {
          kind: "mcp-app",
          lookup: { viewId: "mcp-app-summary" },
        }),
      ).toMatchObject({
        kind: "mcp-app",
        data: { toolInput: { city: "Paris" }, descriptor: { toolCallId: "app-call" } },
      });
      expect(scans).toEqual([]);
    } finally {
      observers.forEach((observer) => observer.mockRestore());
    }
  });
});
