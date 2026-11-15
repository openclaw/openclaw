import fs from "node:fs/promises";
import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core";
import { afterAll, beforeAll, expect, test } from "vitest";
import type { WebSocket } from "ws";
import { createTempDirTracker } from "../../test/helpers/temp-dir.js";
import { resetConfigRuntimeState } from "../config/config.js";
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
