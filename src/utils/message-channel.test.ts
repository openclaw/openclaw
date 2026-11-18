import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setActivePluginRegistry } from "../plugins/runtime.js";
import { createChannelTestPluginBase, createTestRegistry } from "../test-utils/channel-plugins.js";
import * as channels from "./message-channel.js";

const emptyRegistry = createTestRegistry([]);

function registerChannel(id: string, markdownCapable?: boolean) {
  const plugin = createChannelTestPluginBase({ id, markdownCapable });
  setActivePluginRegistry(createTestRegistry([{ pluginId: id, plugin, source: "test" }]));
}

describe("message-channel", () => {
  beforeEach(() => setActivePluginRegistry(emptyRegistry));
  afterEach(() => setActivePluginRegistry(emptyRegistry));

  it("normalizes gateway message channels and rejects unknown values", () => {
    expect(
      ["discord", " imsg ", "webchat", "web", "nope"].map(channels.resolveGatewayMessageChannel),
    ).toEqual(["discord", "imessage", "webchat", undefined, undefined]);
    expect(
      ["discord", "imsg", "webchat", "nope"].map(channels.isDeliverableMessageChannel),
    ).toEqual([true, false, false, false]);
  });

  it("classifies ephemeral Gateway client modes", () => {
    for (const mode of ["cli", "backend", "probe", " CLI "]) {
      expect(channels.isEphemeralGatewayClient({ mode })).toBe(true);
    }
    // "test" stays tracked: suites use test-mode clients as real-client stand-ins.
    for (const mode of ["ui", "webchat", "node", "test", "unknown", undefined]) {
      expect(channels.isEphemeralGatewayClient({ mode })).toBe(false);
    }
  });

  it("classifies the browser copilot as a dedicated browser operator UI", () => {
    const client = { id: "openclaw-browser-copilot", mode: "ui" };
    expect(channels.isBrowserCopilotClient(client)).toBe(true);
    expect(channels.isBrowserOperatorUiClient(client)).toBe(true);
    expect(channels.isOperatorUiClient(client)).toBe(true);
    expect(channels.isBrowserCopilotClient({ id: "webchat", mode: "webchat" })).toBe(false);
    expect(
      channels.isBrowserCopilotClient({ id: "openclaw-browser-copilot", mode: "webchat" }),
    ).toBe(true);
  });

  it("recognises internal non-delivery channel sources", () => {
    for (const channel of ["heartbeat", "cron", "webhook", "voice", "sessions_send"]) {
      expect(channels.isInternalNonDeliveryChannel(channel)).toBe(true);
    }
    for (const channel of ["telegram", "webchat", "", "HEARTBEAT", "cron-event", "exec-event"]) {
      expect(channels.isInternalNonDeliveryChannel(channel)).toBe(false);
    }
  });

  it("reads markdown capability from channel metadata", () => {
    expect(channels.isMarkdownCapableMessageChannel("telegram")).toBe(true);
    expect(channels.isMarkdownCapableMessageChannel("whatsapp")).toBe(false);
    registerChannel("demo-markdown-channel", true);
    expect(channels.isMarkdownCapableMessageChannel("demo-markdown-channel")).toBe(true);
  });

  it("reads Matrix markdown capability from bundled channel catalog metadata", async () => {
    vi.stubEnv("OPENCLAW_BUNDLED_PLUGINS_DIR", path.resolve("extensions"));
    vi.resetModules();
    try {
      const module = await import("./message-channel.js");
      expect(module.isMarkdownCapableMessageChannel("matrix")).toBe(true);
    } finally {
      vi.unstubAllEnvs();
      vi.resetModules();
    }
  });

  it("treats registered plugin channels without markdown metadata as plain text", () => {
    registerChannel("qa-channel");
    expect(channels.isMarkdownCapableMessageChannel("qa-channel")).toBe(false);
  });
});
