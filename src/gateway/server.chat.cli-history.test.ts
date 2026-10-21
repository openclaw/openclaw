import fs from "node:fs/promises";
import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core";
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
const importTimestamp = Date.parse("2026-03-26T16:29:54.800Z");
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

async function withCliHistory(
  sessionId: string,
  cliSessionId: string,
  imported: Parameters<typeof importedMessage>[],
  run: (ws: Awaited<ReturnType<typeof harness.openWs>>) => Promise<void>,
) {
  const ws = await harness.openWs();
  const homeEnvSnapshot = captureEnv(["HOME"]);
  try {
    await connectOk(ws);
    const sessionDir = sessionStoreFixture.open({ fresh: true }).sessionDir;
    const homeDir = path.join(sessionDir, "home");
    const projectsDir = path.join(homeDir, ".claude", "projects", "workspace");
    await fs.mkdir(projectsDir, { recursive: true });
    await fs.writeFile(
      path.join(projectsDir, `${cliSessionId}.jsonl`),
      imported.map((row) => JSON.stringify(importedMessage(...row))).join("\n"),
      "utf-8",
    );
    setTestEnvValue("HOME", homeDir);
    await writeSessionStore({
      entries: {
        main: {
          sessionId,
          sessionFile: path.join(sessionDir, `${sessionId}.jsonl`),
          updatedAt: Date.now() + 60_000,
          modelProvider: "claude-cli",
          model: "claude-sonnet-4-6",
          cliSessionBindings: { "claude-cli": { sessionId: cliSessionId } },
        },
      },
    });
    await run(ws);
  } finally {
    homeEnvSnapshot.restore();
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

function importedMessage(
  role: string,
  uuid: string,
  timestamp: number,
  content: unknown,
  model?: string,
) {
  return {
    type: role,
    uuid,
    timestamp: new Date(timestamp).toISOString(),
    message: { role, content, ...(model ? { model } : {}) },
  };
}

function localMessages(length: number, timestamp: number) {
  return Array.from({ length }, (_, index) =>
    createTextTranscriptEvent(
      index % 2 === 0 ? "user" : "assistant",
      `local-only message ${index + 1}`,
      { timestamp: timestamp + index },
    ),
  );
}

type HistoryMessage = {
  role?: unknown;
  content?: unknown;
  __openclaw?: {
    id?: string;
    seq?: number;
    importedFrom?: unknown;
    externalId?: unknown;
    cliSessionId?: unknown;
  };
};
type HistoryPage = {
  messages?: HistoryMessage[];
  hasMore?: boolean;
  nextOffset?: number;
  totalMessages?: number;
  completeSnapshot?: boolean;
};
const historyPage = (ws: Parameters<typeof rpcReq>[0], params: Record<string, unknown>) =>
  rpcReq<HistoryPage>(ws, "chat.history", { sessionKey: "main", ...params });

test("chat.history deduplicates a structured local Claude delivery with managed audio", async () => {
  const sessionId = "sess-claude-cli-delivery-dedupe";
  const cliSessionId = "5b8b202c-f6bb-4046-9475-d2f15fd07531";
  const deliveryTimestamp = Date.parse("2026-03-26T16:29:55.500Z");
  const managedAudioUrl = "/api/chat/media/outgoing/main/claude-delivery/full";
  await withCliHistory(
    sessionId,
    cliSessionId,
    [
      [
        "assistant",
        "assistant-delivery-ready",
        deliveryTimestamp,
        [{ type: "text", text: "CLAUDE DELIVERY READY" }],
      ],
    ],
    async (ws) => {
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

      const history = await historyPage(ws, { limit: 100 });
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
      expect(assistantMessages[0]?.["__openclaw"]).toMatchObject({
        importedFrom: "claude-cli",
        externalId: "assistant-delivery-ready",
        cliSessionId,
      });
      expect(JSON.stringify(assistantMessages)).not.toContain("[[reply_to:");
    },
  );
});

test("chat.history pages the full local prefix and external-only claude-cli rows", async () => {
  const sessionId = "sess-claude-cli-local-prefix";
  await withCliHistory(
    sessionId,
    "5b8b202c-f6bb-4046-9475-d2f15fd07532",
    [
      ["user", "import-prefix-user", importTimestamp, "import prefix user"],
      ["assistant", "import-prefix-assistant", importTimestamp + 700, "import prefix assistant"],
    ],
    async (ws) => {
      await writeMainSessionTranscript(
        localMessages(70, Date.parse("2026-03-27T00:00:00.000Z")),
        sessionId,
      );

      const history = await historyPage(ws, { limit: 2 });
      expect(history.ok, JSON.stringify(history.error)).toBe(true);
      expect(history.payload?.totalMessages).toBe(72);
      expect(history.payload?.hasMore).toBe(true);
      expect(history.payload?.completeSnapshot).toBeUndefined();
      expect(history.payload?.messages).toHaveLength(2);
      const messages = [...(history.payload?.messages ?? [])];
      let nextOffset = history.payload?.nextOffset;
      while (nextOffset !== undefined) {
        const older = await historyPage(ws, { limit: 20, offset: nextOffset });
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
    },
  );
});

test("chat.history pages when every older claude-cli import duplicates a local row", async () => {
  const sessionId = "sess-claude-cli-dedupe-loop";
  const dupBaseMs = importTimestamp;
  await withCliHistory(
    sessionId,
    "0f5b202c-f6bb-4046-9475-d2f15fd07531",
    [
      ["user", "dup-user-1", dupBaseMs, "dup user question"],
      [
        "assistant",
        "dup-assistant-1",
        dupBaseMs + 1000,
        [{ type: "text", text: "dup assistant reply" }],
        "claude-sonnet-4-6",
      ],
    ],
    async (ws) => {
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
          ...localMessages(45, dupBaseMs + 60_000),
        ],
        sessionId,
      );

      const history = await historyPage(ws, { limit: 1 });
      expect(history.ok, JSON.stringify(history.error)).toBe(true);
      expect(history.payload?.totalMessages).toBe(47);
      expect(history.payload?.hasMore).toBe(true);
      expect(history.payload?.nextOffset).toBeGreaterThan(0);
      expect(JSON.stringify(history.payload?.messages?.at(-1))).toContain("local-only message 45");
    },
  );
});
