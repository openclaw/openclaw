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
  imported: unknown,
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
      JSON.stringify(imported),
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

type HistoryMessage = {
  role?: unknown;
  content?: unknown;
  __openclaw?: {
    importedFrom?: unknown;
    externalId?: unknown;
    cliSessionId?: unknown;
  };
};

test("chat.history deduplicates a structured local Claude delivery with managed audio", async () => {
  const sessionId = "sess-claude-cli-delivery-dedupe";
  const cliSessionId = "5b8b202c-f6bb-4046-9475-d2f15fd07531";
  const deliveryTimestamp = Date.parse("2026-03-26T16:29:55.500Z");
  const managedAudioUrl = "/api/chat/media/outgoing/main/claude-delivery/full";
  await withCliHistory(
    sessionId,
    cliSessionId,
    {
      type: "assistant",
      uuid: "assistant-delivery-ready",
      timestamp: new Date(deliveryTimestamp).toISOString(),
      message: { role: "assistant", content: [{ type: "text", text: "CLAUDE DELIVERY READY" }] },
    },
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

      const history = await rpcReq<{ messages?: HistoryMessage[] }>(ws, "chat.history", {
        sessionKey: "main",
        limit: 100,
      });
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
