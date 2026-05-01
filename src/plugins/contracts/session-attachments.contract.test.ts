import fs from "node:fs/promises";
import path from "node:path";
import {
  createPluginRegistryFixture,
  registerTestPlugin,
} from "openclaw/plugin-sdk/plugin-test-contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import { updateSessionStore, type SessionEntry } from "../../config/sessions.js";
import { withTempConfig } from "../../gateway/test-temp-config.js";
import { resolvePreferredOpenClawTmpDir } from "../../infra/tmp-openclaw-dir.js";
import { resolveAttachmentDelivery, sendPluginSessionAttachment } from "../host-hook-workflow.js";
import { createEmptyPluginRegistry } from "../registry-empty.js";
import { setActivePluginRegistry } from "../runtime.js";
import { createPluginRecord } from "../status.test-helpers.js";
import type { OpenClawPluginApi } from "../types.js";

const workflowMocks = vi.hoisted(() => ({
  sendMessage: vi.fn(),
}));

vi.mock("../../infra/outbound/message.js", () => ({
  sendMessage: workflowMocks.sendMessage,
}));

async function withSessionStore(
  run: (params: { stateDir: string; storePath: string; filePath: string }) => Promise<void>,
) {
  const stateDir = await fs.mkdtemp(
    path.join(resolvePreferredOpenClawTmpDir(), "openclaw-session-attachments-"),
  );
  const storePath = path.join(stateDir, "sessions.json");
  const filePath = path.join(stateDir, "x.txt");
  await fs.writeFile(filePath, "x", "utf8");
  const previousStateDir = process.env.OPENCLAW_STATE_DIR;
  process.env.OPENCLAW_STATE_DIR = stateDir;
  try {
    await withTempConfig({
      cfg: { session: { store: storePath } },
      run: async () => await run({ stateDir, storePath, filePath }),
    });
  } finally {
    if (previousStateDir === undefined) {
      delete process.env.OPENCLAW_STATE_DIR;
    } else {
      process.env.OPENCLAW_STATE_DIR = previousStateDir;
    }
    await fs.rm(stateDir, { recursive: true, force: true });
  }
}

describe("plugin session attachments", () => {
  afterEach(() => {
    workflowMocks.sendMessage.mockReset();
    setActivePluginRegistry(createEmptyPluginRegistry());
  });

  it("resolves channel hint precedence for attachment delivery", () => {
    expect(
      resolveAttachmentDelivery({
        channel: "telegram",
        captionFormat: "html",
        channelHints: { telegram: { parseMode: "MarkdownV2" } },
      }),
    ).toEqual({ parseMode: "MarkdownV2" });
    expect(resolveAttachmentDelivery({ channel: "telegram", captionFormat: "html" })).toEqual({
      parseMode: "HTML",
    });
    expect(resolveAttachmentDelivery({ channel: "telegram", captionFormat: "plain" })).toEqual({
      parseMode: "HTML",
      escapePlainHtmlCaption: true,
    });
    expect(
      resolveAttachmentDelivery({
        channel: "telegram",
        channelHints: {
          telegram: { disableNotification: true, forceDocumentMime: "application/pdf" },
        },
      }),
    ).toEqual({
      disableNotification: true,
      forceDocumentMime: "application/pdf",
    });
    expect(
      resolveAttachmentDelivery({
        channel: "slack",
        channelHints: { slack: { threadTs: "1700000000.000100" } },
      }),
    ).toEqual({ threadTs: "1700000000.000100" });
    expect(resolveAttachmentDelivery({ channel: "discord", captionFormat: "markdownv2" })).toEqual({
      parseMode: "MarkdownV2",
    });
    expect(
      resolveAttachmentDelivery({
        channel: "unknown",
        channelHints: { telegram: { parseMode: "HTML" } },
      }),
    ).toEqual({});
  });

  it("sends validated files through the session delivery route with channel hints", async () => {
    await withSessionStore(async ({ storePath, filePath }) => {
      await updateSessionStore(storePath, (store) => {
        store["agent:main:main"] = {
          sessionId: "session-id",
          updatedAt: Date.now(),
          deliveryContext: {
            channel: "telegram",
            to: "12345",
            accountId: "default",
            threadId: 42,
          },
        } as unknown as SessionEntry;
        return undefined;
      });
      workflowMocks.sendMessage.mockImplementation(async (params: Record<string, unknown>) => ({
        channel: params.channel,
        to: params.to,
        via: "direct" as const,
        mediaUrl: null,
      }));

      const result = await sendPluginSessionAttachment({
        origin: "bundled",
        sessionKey: "agent:main:main",
        files: [{ path: filePath }],
        channelHints: { telegram: { disableNotification: true, parseMode: "HTML" } },
      });

      expect(result).toEqual({
        ok: true,
        channel: "telegram",
        deliveredTo: "12345",
        count: 1,
      });
      expect(workflowMocks.sendMessage).toHaveBeenCalledTimes(1);
      expect(workflowMocks.sendMessage.mock.calls[0]?.[0]).toMatchObject({
        to: "12345",
        channel: "telegram",
        accountId: "default",
        threadId: 42,
        mediaUrls: [filePath],
        bestEffort: true,
        silent: true,
        parseMode: "HTML",
      });
    });
  });

  it("escapes plain Telegram attachment captions before HTML delivery", async () => {
    await withSessionStore(async ({ storePath, filePath }) => {
      await updateSessionStore(storePath, (store) => {
        store["agent:main:main"] = {
          sessionId: "session-id",
          updatedAt: Date.now(),
          deliveryContext: {
            channel: "telegram",
            to: "12345",
          },
        } as unknown as SessionEntry;
        return undefined;
      });
      workflowMocks.sendMessage.mockImplementation(async (params: Record<string, unknown>) => ({
        channel: params.channel,
        to: params.to,
        via: "direct" as const,
        mediaUrl: null,
      }));

      await expect(
        sendPluginSessionAttachment({
          origin: "bundled",
          sessionKey: "agent:main:main",
          files: [{ path: filePath }],
          text: "1 < 2 & 3 > 2",
          captionFormat: "plain",
        }),
      ).resolves.toMatchObject({
        ok: true,
        channel: "telegram",
        deliveredTo: "12345",
        count: 1,
      });
      expect(workflowMocks.sendMessage.mock.calls[0]?.[0]).toMatchObject({
        content: "1 &lt; 2 &amp; 3 &gt; 2",
        parseMode: "HTML",
      });
    });
  });

  it("rejects external plugins and sessions without delivery routes", async () => {
    await withSessionStore(async ({ storePath, filePath }) => {
      await updateSessionStore(storePath, (store) => {
        store["agent:main:main"] = {
          sessionId: "session-id",
          updatedAt: Date.now(),
        } as unknown as SessionEntry;
        return undefined;
      });

      await expect(
        sendPluginSessionAttachment({
          origin: "workspace",
          sessionKey: "agent:main:main",
          files: [{ path: filePath }],
        }),
      ).resolves.toEqual({
        ok: false,
        error: "session attachments are restricted to bundled plugins",
      });
      await expect(
        sendPluginSessionAttachment({
          origin: "bundled",
          sessionKey: "agent:main:main",
          files: [{ path: filePath }],
        }),
      ).resolves.toEqual({
        ok: false,
        error: "session has no active delivery route: agent:main:main",
      });
      expect(workflowMocks.sendMessage).not.toHaveBeenCalled();
    });
  });

  it("rejects malformed or oversized attachment inputs before delivery", async () => {
    await withSessionStore(async ({ storePath, stateDir }) => {
      await updateSessionStore(storePath, (store) => {
        store["agent:main:main"] = {
          sessionId: "session-id",
          updatedAt: Date.now(),
          deliveryContext: {
            channel: "telegram",
            to: "12345",
          },
        } as unknown as SessionEntry;
        return undefined;
      });

      await expect(
        sendPluginSessionAttachment({
          origin: "bundled",
          sessionKey: "agent:main:main",
          files: Array.from({ length: 11 }, () => ({ path: path.join(stateDir, "missing.txt") })),
        }),
      ).resolves.toEqual({
        ok: false,
        error: "at most 10 attachment files are allowed",
      });

      await expect(
        sendPluginSessionAttachment({
          origin: "bundled",
          sessionKey: "agent:main:main",
          files: [null as never],
        }),
      ).resolves.toEqual({
        ok: false,
        error: "attachment file entry must be an object",
      });

      const first = path.join(stateDir, "first.txt");
      const second = path.join(stateDir, "second.txt");
      await fs.writeFile(first, "123", "utf8");
      await fs.writeFile(second, "456", "utf8");
      await expect(
        sendPluginSessionAttachment({
          origin: "bundled",
          sessionKey: "agent:main:main",
          files: [{ path: first }, { path: second }],
          maxBytes: 5,
        }),
      ).resolves.toEqual({
        ok: false,
        error: "attachment files exceed 5 bytes total",
      });
      expect(workflowMocks.sendMessage).not.toHaveBeenCalled();
    });
  });

  it("wires sendSessionAttachment through the plugin API with stale-registry protection", async () => {
    await withSessionStore(async ({ storePath, filePath }) => {
      await updateSessionStore(storePath, (store) => {
        store["agent:main:main"] = {
          sessionId: "session-id",
          updatedAt: Date.now(),
          deliveryContext: {
            channel: "telegram",
            to: "12345",
          },
        } as unknown as SessionEntry;
        return undefined;
      });
      workflowMocks.sendMessage.mockImplementation(async (params: Record<string, unknown>) => ({
        channel: params.channel,
        to: params.to,
        via: "direct" as const,
        mediaUrl: null,
      }));

      const { config, registry } = createPluginRegistryFixture({ session: { store: storePath } });
      let capturedApi: OpenClawPluginApi | undefined;
      registerTestPlugin({
        registry,
        config,
        record: createPluginRecord({
          id: "attachment-plugin",
          name: "Attachment Plugin",
          origin: "bundled",
        }),
        register(api) {
          capturedApi = api;
        },
      });
      setActivePluginRegistry(registry.registry);

      await expect(
        capturedApi?.sendSessionAttachment({
          sessionKey: "agent:main:main",
          files: [{ path: filePath }],
        }),
      ).resolves.toMatchObject({ ok: true, channel: "telegram", count: 1 });

      setActivePluginRegistry(createEmptyPluginRegistry());
      await expect(
        capturedApi?.sendSessionAttachment({
          sessionKey: "agent:main:main",
          files: [{ path: filePath }],
        }),
      ).resolves.toEqual({ ok: false, error: "plugin is not loaded" });
    });
  });
});
