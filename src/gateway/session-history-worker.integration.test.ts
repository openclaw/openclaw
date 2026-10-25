import { createHash } from "node:crypto";
import { channel } from "node:diagnostics_channel";
import { createReadStream } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { expect, it, vi } from "vitest";
import { withinTest } from "../../test/helpers/promise.js";
import { readMainSessionRecoveryCheckpoint } from "../agents/main-session-recovery/main-session-restart-recovery-checkpoint.js";
import { setRuntimeConfigSnapshot } from "../config/runtime-snapshot.js";
import {
  appendTranscriptEvent,
  appendTranscriptMessage,
  replaceSessionEntry,
  waitForSessionTranscriptProjection,
} from "../config/sessions/session-accessor.js";
import { patchSessionEntryCore } from "../config/sessions/session-accessor.sqlite-entry.js";
import { readTranscriptDisplayDelta } from "../config/sessions/session-accessor.sqlite-history-events.test-support.js";
import { readActiveTranscriptEntryAnchor } from "../config/sessions/session-accessor.sqlite-transcript-anchor.js";
import { replaceTranscriptEvents } from "../config/sessions/session-accessor.sqlite-transcript-write.test-support.js";
import { readSessionColdTranscript } from "../config/sessions/session-cold-storage-state.js";
import { runSessionColdStorageMaintenance } from "../config/sessions/session-cold-storage.js";
import {
  createSessionColdStorageFixture,
  currentId,
  historicalId,
  maintenanceConfig,
} from "../config/sessions/session-cold-storage.test-support.js";
import type { ChatHistoryPageParams } from "../config/sessions/session-history-types.js";
import { readSessionHistoryPageInWorker } from "../config/sessions/session-history-worker-runtime.js";
import { runWithSessionTranscriptReadFence } from "../config/sessions/session-transcript-read-fence.js";
import { isSessionHistoryWorkerCold } from "../config/sessions/session-transcript-worker-runtime.js";
import { closeOpenClawAgentDatabasesAsync } from "../state/openclaw-agent-db-lifecycle.js";
import { openOpenClawAgentDatabase } from "../state/openclaw-agent-db.js";
import { closeOpenClawStateDatabaseAsync } from "../state/openclaw-state-db-cache.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { readChatHistoryPage } from "./server-methods/chat-history-pages.js";
import {
  expectMessageIds,
  historyParams,
  historyTarget,
  messageEvent,
  observeHistorySql,
  withHistoryState,
} from "./session-history-events.test-support.js";
import { readSessionHistorySnapshotAsync } from "./session-history-state.js";
import { readChatHistoryMessageId } from "./session-history-tail.js";
import { readSessionPreviewItemsFromTranscriptAsync } from "./session-transcript-preview.js";
import {
  readSessionMessageByIdAsync,
  readSessionTranscriptSummaryAsync,
} from "./session-transcript-readers.js";
import { readLatestSessionUsageFromTranscriptAsync } from "./session-transcript-usage.js";

async function sourceDigest(filePath: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(filePath)) {
    hash.update(chunk);
  }
  return hash.digest("hex");
}

it("reads oversized native history without caller-thread JSON.parse and survives ordinary close", async (test) => {
  await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
    setRuntimeConfigSnapshot({});
    const scope = {
      agentId: "main",
      sessionId: "large-native-history",
      sessionKey: "agent:main:large-native-history",
      storePath: path.join(state.sessionsDir(), "sessions.json"),
    };
    const nativeId = "5b8b202c-f6bb-4046-9475-d2f15fd07539";
    const entry = {
      sessionId: scope.sessionId,
      updatedAt: 1,
      cliSessionBindings: { "claude-cli": { sessionId: nativeId } },
    };
    const canonical = { role: "user", content: "Canonical history stays intact", timestamp: 1 };
    // The fixture owns one reader lifecycle, not unrelated automatic maintenance.
    await patchSessionEntryCore(scope, () => entry, {
      fallbackEntry: entry,
      replaceEntry: true,
      skipMaintenance: true,
    });
    await appendTranscriptMessage(scope, {
      eventId: "canonical",
      now: 1,
      message: canonical,
    });
    await waitForSessionTranscriptProjection(scope);
    const projectDir = path.join(state.home, ".claude", "projects", "large-history");
    const nativePath = path.join(projectDir, `${nativeId}.jsonl`);
    await fs.mkdir(projectDir, { recursive: true });
    const nativeRow = (uuid: string, role: string, content: string, second: number) =>
      JSON.stringify({
        type: role,
        uuid,
        timestamp: new Date(Date.UTC(2026, 9, 14, 0, 0, second)).toISOString(),
        message: { role, content },
      }) + "\n";
    await fs.writeFile(nativePath, nativeRow("warm-native", "assistant", "Warm native reader", 0));
    const params: ChatHistoryPageParams = {
      entry,
      provider: "claude-cli",
      sessionId: scope.sessionId,
      storePath: scope.storePath,
      sessionAgentId: scope.agentId,
      canonicalKey: scope.sessionKey,
      max: 10,
      maxHistoryBytes: 64 * 1024,
      effectiveMaxChars: 4096,
      offset: undefined,
      messageId: undefined,
    };
    const read = (ignoreCliSessionImports = false) =>
      withinTest(
        readChatHistoryPage({ ...params, ignoreCliSessionImports }, test.signal),
        test.signal,
      );
    const close = async () => {
      await closeOpenClawAgentDatabasesAsync(state.root);
      await closeOpenClawStateDatabaseAsync();
    };
    try {
      // Load the native importer before the large read; this is not a fresh parse-only isolate.
      expectMessageIds((await read()).messages, ["canonical", "warm-native"]);
      expect(isSessionHistoryWorkerCold()).toBe(false);
      await fs.writeFile(nativePath, "");
      for (const [uuid, role, mib, second] of [
        ["native-2m", "user", 2, 1],
        ["native-34m", "assistant", 34, 2],
      ] as const) {
        await fs.appendFile(
          nativePath,
          nativeRow(uuid, role, "q".repeat(mib * 1024 * 1024), second),
        );
      }
      await fs.appendFile(
        nativePath,
        nativeRow("native-after", "user", "External history continues", 3),
      );
      const originalSource = await sourceDigest(nativePath);
      const parse = JSON.parse;
      const largeCallerParses: number[] = [];
      using _ = vi.spyOn(JSON, "parse").mockImplementation((source, reviver) => {
        if (typeof source === "string" && source.length > 1024 * 1024) {
          largeCallerParses.push(source.length);
        }
        return parse(source, reviver);
      });
      const page = await read();
      expectMessageIds(page.messages, ["canonical", "native-2m", "native-34m", "native-after"]);
      const placeholder =
        "[Claude CLI history record omitted from context because it exceeded 1 MiB.]";
      expect(page.messages).toMatchObject([
        canonical,
        { role: "user", content: placeholder, __openclaw: { externalId: "native-2m" } },
        { role: "assistant", content: placeholder, __openclaw: { externalId: "native-34m" } },
        { role: "user", content: "External history continues" },
      ]);
      expect(Buffer.byteLength(JSON.stringify(page.messages))).toBeLessThan(4096);
      expect(largeCallerParses).toEqual([]);
      const ordinary = await read(true);
      expect(ordinary.messages).toMatchObject([canonical]);
      expectMessageIds(ordinary.messages, ["canonical"]);

      await close();
      expect(isSessionHistoryWorkerCold()).toBe(true);
      const reopened = await read(true);
      expectMessageIds(reopened.messages, ["canonical"]);
      expect(reopened.messages).toMatchObject([canonical]);
      expect(largeCallerParses).toEqual([]);
      expect(await sourceDigest(nativePath)).toBe(originalSource);
    } finally {
      await close();
    }
  });
});

function observeColdMetadataReads(database: DatabaseSync) {
  const { queries: metadataReads, restore } = observeHistorySql(
    database,
    (sql) =>
      /^select\b.*\bfrom\s+["`]?session_transcript_cold_archives["`]?/is.test(sql) &&
      sql.includes("archive_sha256"),
  );
  return { metadataReads, restore };
}

it.each(["rpc", "message-by-id"] as const)(
  "restores %s history without reading cold metadata on the caller",
  async (transport) => {
    await withHistoryState(async (state) => {
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
  await withHistoryState(async (state) => {
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
  await withHistoryState(async (state) => {
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
      messageEvent("before", { role: "user", content: "Visible requested history" }),
      messageEvent("admitted", { role: "user", content: "Current turn" }, "before"),
      messageEvent(
        "later",
        { role: "assistant", content: "After the admitted boundary" },
        "admitted",
      ),
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
    expectMessageIds(page.messages, ["before", "admitted", "later"]);
    const http = await runWithSessionTranscriptReadFence(admission, readHttp);
    expectMessageIds(http.history.messages, ["before", "admitted", "later"]);
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
  await withHistoryState(async (state) => {
    const target = historyTarget(state, "worker-sparse-history");
    const entry = { sessionId: target.sessionId, updatedAt: 1 };
    await replaceSessionEntry(target, entry);
    const ids = Array.from({ length: 252 }, (_, index) => `row-${index}`);
    await replaceTranscriptEvents(target, [
      { type: "session", version: 3, id: target.sessionId },
      ...ids.map((id, index) =>
        messageEvent(
          id,
          index === 0
            ? { role: "user", content: "Question before silent activity" }
            : {
                role: "assistant",
                content: index === ids.length - 1 ? "Visible final answer" : "NO_REPLY",
              },
          ids[index - 1] ?? null,
        ),
      ),
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
      expectMessageIds(page.messages, [ids[0], ids.at(-1)]);
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
    expectMessageIds(http.history.messages, [ids[0], ids.at(-1)]);
    expect(http.history.hasMore).toBe(false);
    expect(http.rawTranscriptSeq).toBe(252);

    const anchored = await readChatHistoryPage({ ...params, messageId: ids[0] });
    expectMessageIds(anchored.messages, [ids[0]]);
  });
});

it("waits for a missing projection and serves the original history request", async () => {
  await withHistoryState(async (state) => {
    const target = historyTarget(state, "worker-history-rebuild");
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
      expectMessageIds(page.messages, ["recovered"]);
    } finally {
      vi.useRealTimers();
    }
  });
});

it("reads a new branch and reset interval after earlier worker pages settle", async () => {
  await withHistoryState(async (state) => {
    const target = historyTarget(state, "worker-history-branch");
    const entry = { sessionId: target.sessionId, updatedAt: 1 };
    await replaceSessionEntry(target, entry);
    await replaceTranscriptEvents(target, [
      { type: "session", version: 3, id: target.sessionId },
      messageEvent("A", { role: "user", content: "Branch A" }),
      messageEvent("B", { role: "user", content: "Branch B" }),
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
    expectMessageIds((await read()).history.messages, ["A"]);
    await appendTranscriptEvent(target, {
      type: "leaf",
      id: "select-B",
      parentId: "A",
      targetId: "B",
      appendParentId: "B",
    });
    await waitForSessionTranscriptProjection(target);
    const beforeReset = await readDelta(beforeBranch);
    expectMessageIds((await read()).history.messages, ["B"]);
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
    expectMessageIds(reset.history.messages, ["reset-B"]);
    expect(reset.rawTranscriptSeq).toBe(1);
  });
});

it("reduces full transcript recovery, usage, and MCP facts without caller-thread SQLite scans", async () => {
  await withHistoryState(async (state) => {
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
      ...messages.map((message, index) =>
        messageEvent(`summary-${index}`, message, index ? `summary-${index - 1}` : null),
      ),
    ]);
    await waitForSessionTranscriptProjection(target);
    const { db } = openOpenClawAgentDatabase({ agentId: target.agentId, path: target.storePath });
    const { queries: scans, restore } = observeHistorySql(db, (sql) =>
      /\b(?:transcript_events|session_transcript_active_events)\b/iu.test(sql),
    );
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
      restore();
    }
  });
});
