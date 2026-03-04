import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { slackPlugin } from "../../../extensions/slack/src/channel.js";
import { telegramPlugin } from "../../../extensions/telegram/src/channel.js";
import type { OpenClawConfig } from "../../config/config.js";
import * as mediaStore from "../../media/store.js";
import { setActivePluginRegistry } from "../../plugins/runtime.js";
import { createTestRegistry } from "../../test-utils/channel-plugins.js";
import { runMessageAction } from "./message-action-runner.js";

const slackConfig = {
  channels: {
    slack: {
      botToken: "xoxb-test",
      appToken: "xapp-test",
    },
  },
} as OpenClawConfig;

const telegramConfig = {
  channels: {
    telegram: {
      enabled: true,
      botToken: "token-test",
    },
  },
} as OpenClawConfig;

async function withSandbox(test: (sandboxDir: string) => Promise<void>) {
  const sandboxDir = await fs.mkdtemp(path.join(os.tmpdir(), "msg-send-buffer-"));
  try {
    await test(sandboxDir);
  } finally {
    await fs.rm(sandboxDir, { recursive: true, force: true });
  }
}

describe("runMessageAction send buffer hydration", () => {
  afterEach(() => {
    setActivePluginRegistry(createTestRegistry([]));
    vi.restoreAllMocks();
  });

  it("materializes host buffer payloads into media for Slack dry-run sends", async () => {
    const saveMediaBufferSpy = vi.spyOn(mediaStore, "saveMediaBuffer").mockResolvedValue({
      id: "media-1",
      path: "/tmp/openclaw-outbound/test-buffer.txt",
      contentType: "text/plain",
      size: 5,
    });
    setActivePluginRegistry(
      createTestRegistry([{ pluginId: "slack", source: "test", plugin: slackPlugin }]),
    );

    const result = await runMessageAction({
      cfg: slackConfig,
      action: "send",
      params: {
        channel: "slack",
        target: "#C12345678",
        message: "buffer payload",
        buffer: Buffer.from("hello").toString("base64"),
        filename: "test-buffer.txt",
        contentType: "text/plain",
      },
      dryRun: true,
    });

    expect(result.kind).toBe("send");
    expect(result.handledBy).toBe("core");
    expect(saveMediaBufferSpy).not.toHaveBeenCalled();
    if (result.kind !== "send") {
      throw new Error("expected send result");
    }
    expect(result.sendResult?.mediaUrl).toBeNull();
  });

  it("allows attachment-only Slack dry-run sends when buffer is present", async () => {
    const saveMediaBufferSpy = vi.spyOn(mediaStore, "saveMediaBuffer");
    setActivePluginRegistry(
      createTestRegistry([{ pluginId: "slack", source: "test", plugin: slackPlugin }]),
    );

    const result = await runMessageAction({
      cfg: slackConfig,
      action: "send",
      params: {
        channel: "slack",
        target: "#C12345678",
        message: "",
        buffer: Buffer.from("hello").toString("base64"),
        filename: "test-buffer.txt",
        contentType: "text/plain",
      },
      dryRun: true,
    });

    expect(result.kind).toBe("send");
    expect(result.handledBy).toBe("core");
    expect(saveMediaBufferSpy).not.toHaveBeenCalled();
    if (result.kind !== "send") {
      throw new Error("expected send result");
    }
    expect(result.sendResult?.dryRun).toBe(true);
  });

  it("skips sandbox buffer materialization for Telegram dry-run sends", async () => {
    setActivePluginRegistry(
      createTestRegistry([{ pluginId: "telegram", source: "test", plugin: telegramPlugin }]),
    );
    await withSandbox(async (sandboxDir) => {
      const result = await runMessageAction({
        cfg: telegramConfig,
        action: "send",
        params: {
          channel: "telegram",
          target: "12345",
          message: "buffer payload",
          buffer: Buffer.from("hello").toString("base64"),
          filename: "sandbox-buffer.txt",
          contentType: "text/plain",
        },
        dryRun: true,
        sandboxRoot: sandboxDir,
      });

      expect(result.kind).toBe("send");
      expect(result.handledBy).toBe("core");
      if (result.kind !== "send") {
        throw new Error("expected send result");
      }
      expect(result.sendResult?.mediaUrl).toBeNull();
      await expect(
        fs.access(path.join(sandboxDir, "outbound", "sandbox-buffer.txt")),
      ).rejects.toBeDefined();
    });
  });
});
