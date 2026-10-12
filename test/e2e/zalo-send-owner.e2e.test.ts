import type { IncomingMessage, RequestListener } from "node:http";
import {
  createTestRegistry,
  resetPluginRuntimeStateForTest,
  setActivePluginRegistry,
} from "openclaw/plugin-sdk/channel-test-helpers";
import { withServer } from "openclaw/plugin-sdk/test-env";
import { afterEach, describe, expect, it, vi } from "vitest";
import type zaloEntry from "../../extensions/zalo/index.js";
import * as bootstrapRegistry from "../../src/channels/plugins/bootstrap-registry.js";
import { importBundledChannelContractSourceArtifact } from "../../src/channels/plugins/contracts/test-helpers/runtime-artifacts.js";
import type { OpenClawConfig } from "../../src/config/types.openclaw.js";
import { runMessageAction } from "../../src/infra/outbound/message-action-runner.js";

const { zaloPlugin } = await importBundledChannelContractSourceArtifact<{
  zaloPlugin: ReturnType<typeof zaloEntry.loadChannelPlugin>;
}>("zalo", "channel-plugin-api.js", {});

const CHAT_ID = "zalo-chat-1";
const TOKEN = "synthetic-zalo-send-owner";

type ZaloCall = { method: string; body: Record<string, unknown> };

async function readJson(request: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  const raw = Buffer.concat(chunks).toString("utf8");
  return raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
}

function zaloBotApi(calls: ZaloCall[]): RequestListener {
  return (request, response) => {
    void readJson(request).then((body) => {
      const method = (request.url ?? "").split("/").pop() ?? "";
      calls.push({ method, body });
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ ok: true, result: { message_id: `z-${calls.length}` } }));
    });
  };
}

function registerZalo() {
  vi.spyOn(bootstrapRegistry, "getBootstrapChannelPlugin").mockImplementation((id) =>
    id === zaloPlugin.id ? zaloPlugin : undefined,
  );
  setActivePluginRegistry(
    createTestRegistry([{ pluginId: "zalo", source: "test", plugin: zaloPlugin }]),
  );
}

const cfg: OpenClawConfig = { channels: { zalo: { enabled: true, botToken: TOKEN } } };

async function sendWithMessageTool(params: Record<string, unknown>, calls: ZaloCall[]) {
  let result: Awaited<ReturnType<typeof runMessageAction>> | undefined;
  await withServer(zaloBotApi(calls), async (baseUrl) => {
    vi.stubEnv("ZALO_API_URL", baseUrl);
    registerZalo();
    result = await runMessageAction({
      cfg,
      action: "send",
      params: { channel: "zalo", target: CHAT_ID, ...params },
      conversationReadOrigin: "direct-operator",
    });
  });
  return result;
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  resetPluginRuntimeStateForTest();
});

describe("Zalo message-tool send", () => {
  it("delivers every character of a message longer than Zalo's 2000-character limit", async () => {
    const calls: ZaloCall[] = [];
    const message = Array.from({ length: 500 }, (_, i) => `word${i}`).join(" ");
    expect(message.length).toBeGreaterThan(3000);

    const result = await sendWithMessageTool({ message }, calls);

    expect(result?.handledBy).toBe("core");
    expect(calls.map((call) => call.method)).toEqual(["sendMessage", "sendMessage"]);
    const texts = calls.map((call) => String(call.body.text));
    expect(texts.every((text) => text.length <= 2000)).toBe(true);
    expect(texts.join(" ")).toBe(message);
    expect(calls.every((call) => call.body.chat_id === CHAT_ID)).toBe(true);
  });

  it("sends whitespace-only media as text", async () => {
    const calls: ZaloCall[] = [];

    await sendWithMessageTool({ message: "hello there", media: "   " }, calls);

    expect(calls).toEqual([
      { method: "sendMessage", body: { chat_id: CHAT_ID, text: "hello there" } },
    ]);
  });

  it("still rejects unsupported actions before contacting Zalo", async () => {
    const calls: ZaloCall[] = [];

    await expect(
      withServer(zaloBotApi(calls), async (baseUrl) => {
        vi.stubEnv("ZALO_API_URL", baseUrl);
        registerZalo();
        await runMessageAction({
          cfg,
          action: "react",
          params: { channel: "zalo", target: CHAT_ID, messageId: "m1", emoji: "eyes" },
          conversationReadOrigin: "delegated",
        });
      }),
    ).rejects.toThrow("Message action react not supported for channel zalo.");
    expect(calls).toEqual([]);
  });

  it("sends a bare photo then the whole long caption instead of cutting it", async () => {
    const calls: ZaloCall[] = [];
    const message = Array.from({ length: 500 }, (_, i) => `cap${i}`).join(" ");

    await sendWithMessageTool({ message, media: "https://example.com/photo.jpg" }, calls);

    expect(calls[0]).toEqual({
      method: "sendPhoto",
      body: { chat_id: CHAT_ID, photo: "https://example.com/photo.jpg" },
    });
    const rest = calls.slice(1);
    expect(rest.length).toBeGreaterThan(1);
    expect(rest.every((call) => call.method === "sendMessage")).toBe(true);
    const texts = rest.map((call) => String(call.body.text));
    expect(texts.every((text) => text.length <= 2000)).toBe(true);
    expect(texts.join(" ")).toBe(message);
  });
});
