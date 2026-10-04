import fs from "node:fs/promises";
import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core";
import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import { afterAll, beforeAll, expect, test } from "vitest";
import { createTempDirTracker } from "../../test/helpers/temp-dir.js";
import { resetConfigRuntimeState } from "../config/config.js";
import { captureEnv, setTestEnvValue } from "../test-utils/env.js";
import { createTextTranscriptEvent } from "./server-chat.agent-events.test-helpers.js";
import { disposeSessionReadContexts } from "./server-methods/sessions-read-cache.test-support.js";
import {
  createDirectChatSessionStoreFixture,
  writeMainChatSessionTranscript as writeMainSessionTranscript,
} from "./server.chat-session-store.test-support.js";
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
  }) => Promise<void>,
) {
  const ws = await harness.openWs();
  try {
    await run({
      ws,
      createSessionDir: async (options) => sessionStoreFixture.open(options).sessionDir,
    });
  } finally {
    await disposeSessionReadContexts();
    await sessionStoreFixture.reset();
    directories.cleanup();
    resetConfigRuntimeState();
    if (process.env.OPENCLAW_CONFIG_PATH) {
      await fs.rm(process.env.OPENCLAW_CONFIG_PATH, { force: true });
    }
    ws.close();
  }
}

type StoredSessionEntry = Parameters<typeof writeSessionStore>[0]["entries"][string];
async function writeStoredMainSession(entry: StoredSessionEntry) {
  await writeSessionStore({ entries: { main: entry } });
}
function makeMainSessionParams(overrides: Record<string, unknown> = {}) {
  return { sessionKey: "main", ...overrides };
}
function makeClaudeCliSessionEntry(
  sessionDir: string,
  sessionId: string,
  cliSessionId: string,
): StoredSessionEntry {
  return {
    sessionId,
    sessionFile: path.join(sessionDir, `${sessionId}.jsonl`),
    updatedAt: Date.now() + 60_000,
    modelProvider: "claude-cli",
    model: "claude-sonnet-4-6",
    cliSessionBindings: { "claude-cli": { sessionId: cliSessionId } },
  };
}
function readOpenClawSeq(message: unknown): unknown {
  return asOptionalRecord(asOptionalRecord(message)?.["__openclaw"])?.seq;
}

test("chat.history deduplicates a structured local Claude delivery with managed audio", async () => {
  await withGatewayChatHarness(async ({ ws, createSessionDir }) => {
    await connectOk(ws);
    const sessionDir = await createSessionDir({ fresh: true });
    const sessionId = "sess-claude-cli-delivery-dedupe";
    const cliSessionId = "5b8b202c-f6bb-4046-9475-d2f15fd07531";
    const deliveryTimestamp = Date.parse("2026-03-26T16:29:55.500Z");
    const homeEnvSnapshot = captureEnv(["HOME"]);
    const homeDir = path.join(sessionDir, "home");
    const claudeProjectsDir = path.join(homeDir, ".claude", "projects", "workspace");
    const managedAudioUrl = "/api/chat/media/outgoing/main/claude-delivery/full";
    await fs.mkdir(claudeProjectsDir, { recursive: true });
    await fs.writeFile(
      path.join(claudeProjectsDir, `${cliSessionId}.jsonl`),
      JSON.stringify({
        type: "assistant",
        uuid: "assistant-delivery-ready",
        timestamp: new Date(deliveryTimestamp).toISOString(),
        message: {
          role: "assistant",
          content: [{ type: "text", text: "CLAUDE DELIVERY READY" }],
        },
      }),
      "utf-8",
    );
    setTestEnvValue("HOME", homeDir);
    try {
      await writeStoredMainSession(makeClaudeCliSessionEntry(sessionDir, sessionId, cliSessionId));
      await writeMainSessionTranscript(
        [
          createTextTranscriptEvent("assistant", "CLAUDE DELIVERY READY", {
            timestamp: deliveryTimestamp,
            message: {
              content: [
                {
                  type: "text",
                  text: "CLAUDE DELIVERY READY",
                },
                { type: "audio", url: managedAudioUrl, openUrl: managedAudioUrl },
              ],
              openclawDelivery: { replyToId: "delivery-run-1" },
            },
          }),
        ],
        sessionId,
      );

      const history = await rpcReq<{
        messages?: Array<{
          role?: unknown;
          content?: unknown;
          __openclaw?: {
            importedFrom?: unknown;
            externalId?: unknown;
            cliSessionId?: unknown;
          };
        }>;
      }>(ws, "chat.history", makeMainSessionParams({ limit: 100 }));
      expect(history.ok, JSON.stringify(history.error)).toBe(true);
      const assistantMessages = (history.payload?.messages ?? []).filter(
        (message) => message.role === "assistant",
      );
      expect(assistantMessages).toHaveLength(1);
      const survivingContent = expectDefined(
        assistantMessages[0]?.content,
        "surviving assistant content",
      );
      expect(Array.isArray(survivingContent)).toBe(true);
      const contentBlocks = survivingContent as Array<{ type?: unknown; text?: unknown }>;
      expect(
        contentBlocks.filter(
          (block) => block.type === "text" && block.text === "CLAUDE DELIVERY READY",
        ),
      ).toHaveLength(1);
      expect(contentBlocks.filter((block) => block.type === "audio")).toHaveLength(1);
      expect(assistantMessages[0]?.["__openclaw"]).toEqual(
        expect.objectContaining({
          importedFrom: "claude-cli",
          externalId: "assistant-delivery-ready",
          cliSessionId,
        }),
      );
      expect(JSON.stringify(assistantMessages)).not.toContain("[[reply_to:");
    } finally {
      homeEnvSnapshot.restore();
    }
  });
});

test("chat.history pages the full local prefix and external-only claude-cli rows", async () => {
  await withGatewayChatHarness(async ({ ws, createSessionDir }) => {
    await connectOk(ws);
    const sessionDir = await createSessionDir({ fresh: true });
    const sessionId = "sess-claude-cli-local-prefix";
    const cliSessionId = "5b8b202c-f6bb-4046-9475-d2f15fd07532";
    const homeEnvSnapshot = captureEnv(["HOME"]);
    const homeDir = path.join(sessionDir, "home");
    const claudeProjectsDir = path.join(homeDir, ".claude", "projects", "workspace");
    await fs.mkdir(claudeProjectsDir, { recursive: true });
    await fs.writeFile(
      path.join(claudeProjectsDir, `${cliSessionId}.jsonl`),
      [
        JSON.stringify({
          type: "user",
          uuid: "import-prefix-user",
          timestamp: "2026-03-26T16:29:54.800Z",
          message: { role: "user", content: "import prefix user" },
        }),
        JSON.stringify({
          type: "assistant",
          uuid: "import-prefix-assistant",
          timestamp: "2026-03-26T16:29:55.500Z",
          message: { role: "assistant", content: "import prefix assistant" },
        }),
      ].join("\n"),
      "utf-8",
    );
    setTestEnvValue("HOME", homeDir);
    try {
      await writeStoredMainSession(makeClaudeCliSessionEntry(sessionDir, sessionId, cliSessionId));
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

      type ImportedHistoryPage = {
        messages?: Array<{ __openclaw?: { id?: string; seq?: number } }>;
        hasMore?: boolean;
        nextOffset?: number;
        totalMessages?: number;
        completeSnapshot?: boolean;
      };
      const history = await rpcReq<ImportedHistoryPage>(
        ws,
        "chat.history",
        makeMainSessionParams({ limit: 2 }),
      );
      expect(history.ok, JSON.stringify(history.error)).toBe(true);
      expect(history.payload?.totalMessages).toBe(72);
      expect(history.payload?.hasMore).toBe(true);
      expect(history.payload?.completeSnapshot).toBeUndefined();
      expect(history.payload?.messages).toHaveLength(2);
      const messages = [...(history.payload?.messages ?? [])];
      let nextOffset = history.payload?.nextOffset;
      while (nextOffset !== undefined) {
        const older = await rpcReq<ImportedHistoryPage>(
          ws,
          "chat.history",
          makeMainSessionParams({ limit: 20, offset: nextOffset }),
        );
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
          const metadata = expectDefined(message["__openclaw"], "history metadata");
          return metadata.seq !== undefined
            ? `seq:${metadata.seq}`
            : `id:${expectDefined(metadata.id, "history id")}`;
        }),
      );
      expect(deliveredIdentities.size).toBe(72);
      expect(deliveredIdentities).toContain("id:import-prefix-user");
      expect(deliveredIdentities).toContain("id:import-prefix-assistant");
      for (let index = 1; index <= 70; index += 1) {
        expect(deliveredIdentities).toContain(`seq:${index}`);
      }
    } finally {
      homeEnvSnapshot.restore();
    }
  });
});

test("chat.history keeps offset paging when a claude-cli binding has no import", async () => {
  await withGatewayChatHarness(async ({ ws, createSessionDir }) => {
    await connectOk(ws);
    const sessionDir = await createSessionDir({ fresh: true });
    const sessionId = "sess-claude-cli-missing-import";
    const homeEnvSnapshot = captureEnv(["HOME"]);
    setTestEnvValue("HOME", path.join(sessionDir, "empty-home"));
    try {
      await writeStoredMainSession(
        makeClaudeCliSessionEntry(sessionDir, sessionId, "missing-cli-session"),
      );
      await writeMainSessionTranscript(
        Array.from({ length: 5 }, (_, index) =>
          createTextTranscriptEvent(
            index % 2 === 0 ? "user" : "assistant",
            `local message ${index + 1}`,
            { timestamp: Date.now() + index },
          ),
        ),
        sessionId,
      );

      const firstPage = await rpcReq<{
        messages?: Array<{ __openclaw?: { seq?: number } }>;
        hasMore?: boolean;
        nextOffset?: number;
        totalMessages?: number;
      }>(ws, "chat.history", makeMainSessionParams({ limit: 2 }));
      expect(firstPage.ok).toBe(true);
      expect(firstPage.payload?.messages?.map(readOpenClawSeq)).toEqual([4, 5]);
      expect(firstPage.payload?.hasMore).toBe(true);
      expect(firstPage.payload?.nextOffset).toBe(2);
      expect(firstPage.payload?.totalMessages).toBe(5);

      const secondPage = await rpcReq<{
        messages?: Array<{ __openclaw?: { seq?: number } }>;
        hasMore?: boolean;
        nextOffset?: number;
      }>(
        ws,
        "chat.history",
        makeMainSessionParams({
          limit: 2,
          offset: firstPage.payload?.nextOffset,
        }),
      );
      expect(secondPage.ok).toBe(true);
      expect(secondPage.payload?.messages?.map(readOpenClawSeq)).toEqual([2, 3]);
      expect(secondPage.payload?.hasMore).toBe(true);
      expect(secondPage.payload?.nextOffset).toBe(4);
    } finally {
      homeEnvSnapshot.restore();
    }
  });
});

test("chat.history pages when every older claude-cli import duplicates a local row", async () => {
  await withGatewayChatHarness(async ({ ws, createSessionDir }) => {
    await connectOk(ws);
    const sessionDir = await createSessionDir({ fresh: true });
    const sessionId = "sess-claude-cli-dedupe-loop";
    const homeEnvSnapshot = captureEnv(["HOME"]);
    const homeDir = path.join(sessionDir, "home");
    const cliSessionId = "0f5b202c-f6bb-4046-9475-d2f15fd07531";
    const claudeProjectsDir = path.join(homeDir, ".claude", "projects", "workspace");
    const dupBaseMs = Date.parse("2026-03-26T16:29:54.800Z");
    await fs.mkdir(claudeProjectsDir, { recursive: true });
    await fs.writeFile(
      path.join(claudeProjectsDir, `${cliSessionId}.jsonl`),
      [
        JSON.stringify({
          type: "user",
          uuid: "dup-user-1",
          timestamp: new Date(dupBaseMs).toISOString(),
          message: { role: "user", content: "dup user question" },
        }),
        JSON.stringify({
          type: "assistant",
          uuid: "dup-assistant-1",
          timestamp: new Date(dupBaseMs + 1000).toISOString(),
          message: {
            role: "assistant",
            model: "claude-sonnet-4-6",
            content: [{ type: "text", text: "dup assistant reply" }],
          },
        }),
      ].join("\n"),
      "utf-8",
    );
    setTestEnvValue("HOME", homeDir);
    try {
      await writeStoredMainSession(makeClaudeCliSessionEntry(sessionDir, sessionId, cliSessionId));
      // The two import copies are the oldest local records; 45 newer
      // local-only records push them past the limit-1 tail window (40 raw
      // messages), so the tail merge incorporates the import while the full
      // read dedupes everything. This layout used to recurse forever.
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

      const history = await rpcReq<{
        messages?: unknown[];
        hasMore?: boolean;
        nextOffset?: number;
        totalMessages?: number;
      }>(ws, "chat.history", makeMainSessionParams({ limit: 1 }));
      expect(history.ok, JSON.stringify(history.error)).toBe(true);
      expect(history.payload?.totalMessages).toBe(47);
      expect(history.payload?.hasMore).toBe(true);
      expect(history.payload?.nextOffset).toBeGreaterThan(0);
      expect(JSON.stringify(history.payload?.messages?.at(-1))).toContain("local-only message 45");
    } finally {
      homeEnvSnapshot.restore();
    }
  });
});
