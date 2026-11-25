import fs from "node:fs/promises";
import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core";
import { afterAll, beforeAll, expect, test } from "vitest";
import type { WebSocket } from "ws";
import { createTempDirTracker } from "../../test/helpers/temp-dir.js";
import { hashCliImageTurnEntryId } from "../agents/cli-image-turn-correlation.js";
import { prepareCliPromptImagePayload } from "../agents/cli-runner/helpers.js";
import { resetConfigRuntimeState } from "../config/config.js";
import { historyLane } from "../config/sessions/session-transcript-worker-resources.js";
import { createUserTurnTranscriptRecorder } from "../sessions/user-turn-transcript.js";
import {
  createClaudeTextHistoryLines,
  withClaudeProjectsDir,
} from "./cli-session-history.test-support.js";
import { createTextTranscriptEvent } from "./server-chat.agent-events.test-helpers.js";
import { disposeSessionReadContexts } from "./server-methods/sessions-read-cache.test-support.js";
import {
  createDirectChatSessionStoreFixture,
  writeMainChatSessionTranscript as writeMainSessionTranscript,
} from "./server.chat-session-store.test-support.js";
import { requireGatewayRecord } from "./test-helpers.assertions.js";
import {
  connectOk,
  createGatewaySuiteHarness,
  installGatewayTestHooks,
  rpcReq,
  writeSessionStore,
} from "./test-helpers.js";

installGatewayTestHooks({ scope: "suite" });
const directories = createTempDirTracker();
const sessionStoreFixture = createDirectChatSessionStoreFixture(directories);
let harness: Awaited<ReturnType<typeof createGatewaySuiteHarness>>;
beforeAll(async () => {
  harness = await createGatewaySuiteHarness();
  sessionStoreFixture.prepare();
});
afterAll(async () => {
  try {
    await sessionStoreFixture.dispose();
  } finally {
    await harness.close();
  }
});

async function withGatewayChatHarness(
  run: (context: {
    ws: Awaited<ReturnType<typeof harness.openWs>>;
    createSessionDir: (options?: { fresh?: boolean }) => Promise<string>;
    filePath: string;
    cliSessionId: string;
  }) => Promise<void>,
) {
  const ws = await harness.openWs();
  try {
    await withClaudeProjectsDir(async ({ filePath, sessionId: cliSessionId }) => {
      try {
        await run({
          ws,
          createSessionDir: async (options) => sessionStoreFixture.open(options).sessionDir,
          filePath,
          cliSessionId,
        });
      } finally {
        await disposeSessionReadContexts();
      }
    });
  } finally {
    await sessionStoreFixture.reset();
    directories.cleanup();
    resetConfigRuntimeState();
    if (process.env.OPENCLAW_CONFIG_PATH) {
      await fs.rm(process.env.OPENCLAW_CONFIG_PATH, { force: true });
    }
    ws.close();
  }
}

type HistoryPage = {
  messages?: Record<string, unknown>[];
  hasMore?: boolean;
  nextOffset?: number;
  totalMessages?: number;
  completeSnapshot?: boolean;
};
function readHistory(ws: WebSocket, params: Record<string, unknown>) {
  return rpcReq<HistoryPage>(ws, "chat.history", { sessionKey: "main", ...params });
}
async function writeStoredMainSession(sessionDir: string, sessionId: string, cliSessionId: string) {
  const entry = {
    sessionId,
    sessionFile: path.join(sessionDir, `${sessionId}.jsonl`),
    updatedAt: Date.now() + 60_000,
    modelProvider: "claude-cli",
    model: "claude-sonnet-4-6",
    cliSessionBindings: { "claude-cli": { sessionId: cliSessionId } },
  };
  await writeSessionStore({ entries: { main: entry } });
}

test("chat.history keeps the submitted documents instead of a second expanded Claude prompt", async () => {
  await withGatewayChatHarness(async ({ ws, createSessionDir, filePath, cliSessionId }) => {
    await connectOk(ws);
    const sessionDir = await createSessionDir({ fresh: true });
    const sessionId = "document-history";
    const id = "local-document-turn";
    const caption = "Compare these notes";
    const media = ["first.md", "second.md"].map((fileName) => ({
      kind: "document" as const,
      contentType: "text/markdown",
      fileName,
      url: `media://inbound/${fileName}`,
    }));
    const expanded = `[media attached: 2 files]\n${caption}\n\n<file name="first.md">private document content</file>`;
    const { prompt } = await prepareCliPromptImagePayload({
      backend: { command: "claude", imageArg: "@" },
      workspaceDir: sessionDir,
      media,
      preparedImages: [],
      prompt: expanded,
      imageTurnKey: hashCliImageTurnEntryId(id),
    });
    expect(prompt).toContain(expanded);
    await fs.writeFile(
      filePath,
      createClaudeTextHistoryLines([
        { role: "user", uuid: "native-caption", content: caption },
        { role: "user", uuid: "native-document-turn", content: prompt },
        { role: "user", uuid: "unrelated-native-turn", content: expanded },
      ]),
    );
    await writeStoredMainSession(sessionDir, sessionId, cliSessionId);
    await writeMainSessionTranscript(
      [
        createTextTranscriptEvent("user", caption, {
          id,
          timestamp: Date.parse("2026-03-26T16:29:54.801Z"),
          message: { __openclaw: { media } },
        }),
      ],
      sessionId,
    );
    const history = await readHistory(ws, { limit: 100 });
    expect(history.ok, JSON.stringify(history.error)).toBe(true);
    const users = history.payload?.messages?.filter((message) => message.role === "user");
    expect(users).toHaveLength(3);
    expect(users).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          content: caption,
          __openclaw: expect.objectContaining({ externalId: "native-caption" }),
        }),
        expect.objectContaining({
          __openclaw: expect.objectContaining({
            id,
            media: media.map((fact) => expect.objectContaining({ fileName: fact.fileName })),
            externalId: "native-document-turn",
          }),
        }),
        expect.objectContaining({ content: expanded }),
      ]),
    );
  });
});

test("chat.history refreshes a warm worker after an accepted document steer is stamped", async () => {
  await withGatewayChatHarness(async ({ ws, createSessionDir, filePath, cliSessionId }) => {
    await connectOk(ws);
    const sessionDir = await createSessionDir({ fresh: true });
    const sessionId = "warm-document-steer";
    await writeStoredMainSession(sessionDir, sessionId, cliSessionId);
    const caption = "Read this note";
    const media = [
      {
        kind: "document",
        contentType: "text/markdown",
        fileName: "note.md",
        url: "media://inbound/note.md",
      },
    ];
    const identity = { importedFrom: "claude-cli", cliSessionId, externalId: "accepted-input" };
    // Claude records direct stdin as a queued command, not a second displayable user row.
    const native = [
      createClaudeTextHistoryLines([{ role: "user", uuid: "independent", content: caption }]),
      JSON.stringify({
        type: "attachment",
        uuid: "envelope",
        sessionId: cliSessionId,
        attachment: { type: "queued_command", source_uuid: identity.externalId, prompt: caption },
      }),
    ].join("\n");
    await fs.writeFile(filePath, native);
    const recorder = createUserTurnTranscriptRecorder({
      target: {
        agentId: "main",
        sessionKey: "agent:main:main",
        sessionId,
        storePath: path.join(sessionDir, "sessions.json"),
        sessionEntry: undefined,
      },
      message: {
        role: "user",
        content: caption,
        timestamp: Date.parse("2026-03-26T16:29:54.801Z"),
        __openclaw: { media },
      },
    });
    const persisted = expectDefined(
      await recorder.persistApproved({ updateMode: "none" }),
      "accepted document steer",
    );
    const page = async () => {
      const response = await readHistory(ws, { limit: 10 });
      expect(response.ok, JSON.stringify(response.error)).toBe(true);
      return response.payload?.messages;
    };
    const before = await page();
    expect(before).toMatchObject([
      { __openclaw: { id: persisted.messageId, externalId: "independent", media } },
    ]);
    const { workers, workersCreated } = historyLane.pool.getSnapshot();
    expect(workers).toBe(1);

    await recorder.confirmSteerTargetRunIdForPersistence?.("active-run", identity);
    expect(recorder.getAdmissionReceipt()).toEqual(persisted.admission);
    expect(recorder.getPersistedMessage?.()?.["__openclaw"]).toMatchObject({ ...identity, media });
    const after = await page();
    expect(historyLane.pool.getSnapshot()).toMatchObject({ workers, workersCreated });
    expect(await fs.readFile(filePath, "utf8")).toBe(native);
    expect(after).toMatchObject([
      { content: caption, __openclaw: { id: "independent", externalId: "independent" } },
      { content: caption, __openclaw: { id: persisted.messageId, ...identity, media } },
    ]);
    expect(after?.[0]?.["__openclaw"]).not.toHaveProperty("media");
  });
});

test("chat.history deduplicates a structured local Claude delivery with managed audio", async () => {
  await withGatewayChatHarness(async ({ ws, createSessionDir, filePath, cliSessionId }) => {
    await connectOk(ws);
    const sessionDir = await createSessionDir({ fresh: true });
    const sessionId = "sess-claude-cli-delivery-dedupe";
    const deliveryTimestamp = Date.parse("2026-03-26T16:29:55.500Z");
    const managedAudioUrl = "/api/chat/media/outgoing/main/claude-delivery/full";
    await fs.writeFile(
      filePath,
      createClaudeTextHistoryLines([
        { role: "assistant", uuid: "assistant-delivery-ready", content: "CLAUDE DELIVERY READY" },
      ]),
      "utf-8",
    );
    await writeStoredMainSession(sessionDir, sessionId, cliSessionId);
    await writeMainSessionTranscript(
      [
        createTextTranscriptEvent("assistant", "CLAUDE DELIVERY READY", {
          timestamp: deliveryTimestamp,
          message: {
            content: [
              { type: "text", text: "CLAUDE DELIVERY READY" },
              { type: "audio", url: managedAudioUrl, openUrl: managedAudioUrl },
            ],
            openclawDelivery: { replyToId: "delivery-run-1" },
          },
        }),
      ],
      sessionId,
    );
    const history = await readHistory(ws, { limit: 100 });
    expect(history.ok, JSON.stringify(history.error)).toBe(true);
    const assistantMessages = (history.payload?.messages ?? []).filter(
      (message) => message.role === "assistant",
    );
    expect(assistantMessages).toHaveLength(1);
    expect(assistantMessages[0]?.content).toMatchObject([
      { type: "text", text: "CLAUDE DELIVERY READY" },
      { type: "audio", url: managedAudioUrl, openUrl: managedAudioUrl },
    ]);
    expect(assistantMessages[0]?.["__openclaw"]).toEqual(
      expect.objectContaining({
        importedFrom: "claude-cli",
        externalId: "assistant-delivery-ready",
        cliSessionId,
      }),
    );
    expect(JSON.stringify(assistantMessages)).not.toContain("[[reply_to:");
  });
});

test("chat.history pages the full local prefix and external-only claude-cli rows", async () => {
  await withGatewayChatHarness(async ({ ws, createSessionDir, filePath, cliSessionId }) => {
    await connectOk(ws);
    const sessionDir = await createSessionDir({ fresh: true });
    const sessionId = "sess-claude-cli-local-prefix";
    await fs.writeFile(
      filePath,
      createClaudeTextHistoryLines([
        { role: "user", uuid: "import-prefix-user", content: "import prefix user" },
        { role: "assistant", uuid: "import-prefix-assistant", content: "import prefix assistant" },
      ]),
      "utf-8",
    );
    await writeStoredMainSession(sessionDir, sessionId, cliSessionId);
    await writeMainSessionTranscript(
      Array.from({ length: 70 }, (_, index) =>
        createTextTranscriptEvent(
          index % 2 === 0 ? "user" : "assistant",
          `local-only message ${index + 1}`,
          { timestamp: Date.parse("2026-03-27T00:00:00.000Z") + index },
        ),
      ),
      sessionId,
    );
    const history = await readHistory(ws, { limit: 2 });
    expect(history.ok, JSON.stringify(history.error)).toBe(true);
    expect(history.payload?.totalMessages).toBe(72);
    expect(history.payload?.hasMore).toBe(true);
    expect(history.payload?.completeSnapshot).toBeUndefined();
    expect(history.payload?.messages).toHaveLength(2);
    const messages = [...(history.payload?.messages ?? [])];
    let nextOffset = history.payload?.nextOffset;
    while (nextOffset !== undefined) {
      const older = await readHistory(ws, { limit: 20, offset: nextOffset });
      expect(older.ok).toBe(true);
      expect(older.payload?.messages?.length).toBeLessThanOrEqual(20);
      messages.unshift(...(older.payload?.messages ?? []));
      if (older.payload?.nextOffset !== undefined) {
        expect(older.payload.nextOffset).toBeGreaterThan(nextOffset);
      }
      nextOffset = older.payload?.nextOffset;
    }
    const deliveredIdentities = new Set(
      messages.map((message) => {
        const metadata = requireGatewayRecord(message["__openclaw"], "history metadata");
        return typeof metadata.seq === "number"
          ? `seq:${metadata.seq}`
          : `id:${String(expectDefined(metadata.id, "history id"))}`;
      }),
    );
    expect(deliveredIdentities.size).toBe(72);
    expect(deliveredIdentities).toContain("id:import-prefix-user");
    expect(deliveredIdentities).toContain("id:import-prefix-assistant");
    for (let index = 1; index <= 70; index += 1) {
      expect(deliveredIdentities).toContain(`seq:${index}`);
    }
  });
});

test("chat.history pages when every older claude-cli import duplicates a local row", async () => {
  await withGatewayChatHarness(async ({ ws, createSessionDir, filePath, cliSessionId }) => {
    await connectOk(ws);
    const sessionDir = await createSessionDir({ fresh: true });
    const sessionId = "sess-claude-cli-dedupe-loop";
    const dupBaseMs = Date.parse("2026-03-26T16:29:54.800Z");
    await fs.writeFile(
      filePath,
      createClaudeTextHistoryLines([
        { role: "user", uuid: "dup-user-1", content: "dup user question" },
        { role: "assistant", uuid: "dup-assistant-1", content: "dup assistant reply" },
      ]),
      "utf-8",
    );
    await writeStoredMainSession(sessionDir, sessionId, cliSessionId);
    // Both imported copies precede the limit-1 tail window of 40 raw messages.
    await writeMainSessionTranscript(
      [
        createTextTranscriptEvent("user", "dup user question", { timestamp: dupBaseMs }),
        createTextTranscriptEvent("assistant", "dup assistant reply", {
          timestamp: dupBaseMs + 1000,
        }),
        ...Array.from({ length: 45 }, (_, index) =>
          createTextTranscriptEvent(
            index % 2 === 0 ? "user" : "assistant",
            `local-only message ${index + 1}`,
            { timestamp: dupBaseMs + 60_000 + index },
          ),
        ),
      ],
      sessionId,
    );
    const history = await readHistory(ws, { limit: 1 });
    expect(history.ok, JSON.stringify(history.error)).toBe(true);
    expect(history.payload?.totalMessages).toBe(47);
    expect(history.payload?.hasMore).toBe(true);
    expect(history.payload?.nextOffset).toBeGreaterThan(0);
    expect(JSON.stringify(history.payload?.messages?.at(-1))).toContain("local-only message 45");
  });
});
