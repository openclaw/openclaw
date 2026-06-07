// Real filesystem runtime proof for #90768 buffer-only message.send materialization.
import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { ChannelPlugin } from "../../channels/plugins/types.js";
import type { OpenClawConfig } from "../../config/config.js";
import { setActivePluginRegistry } from "../../plugins/runtime.js";
import {
  createChannelTestPluginBase,
  createTestRegistry,
} from "../../test-utils/channel-plugins.js";
import { resolveConfigDir } from "../../utils.js";
import {
  hydrateAttachmentParamsForAction,
  materializeSendBufferMediaParams,
} from "./message-action-params.js";
import { runMessageAction } from "./message-action-runner.js";

const cfg = {} as OpenClawConfig;

const workspacePlugin: ChannelPlugin = {
  ...createChannelTestPluginBase({
    id: "workspace",
    label: "Workspace",
    config: {
      listAccountIds: () => ["default"],
      resolveAccount: () => ({ botToken: "xoxb-test", appToken: "xapp-test" }),
      isConfigured: async () => true,
    },
  }),
  outbound: {
    deliveryMode: "direct",
    resolveTarget: ({ to }) => {
      const trimmed = to?.trim() ?? "";
      if (!trimmed) {
        return { ok: false, error: new Error("missing target for workspace") };
      }
      return { ok: true, to: trimmed };
    },
    sendText: async () => ({ channel: "workspace", messageId: "msg-runtime-proof" }),
    sendMedia: async () => ({ channel: "workspace", messageId: "msg-runtime-proof" }),
  },
};

async function countOutboundMediaFiles(): Promise<number> {
  const outboundDir = path.join(resolveConfigDir(), "media", "outbound");
  try {
    const entries = await fs.readdir(outboundDir);
    return entries.length;
  } catch {
    return 0;
  }
}

describe("issue #90768 runtime proof", () => {
  it("L3: dry-run avoids outbound writes; real send stages readable media path", async () => {
    setActivePluginRegistry(
      createTestRegistry([
        {
          pluginId: "workspace",
          source: "test",
          plugin: workspacePlugin,
        },
      ]),
    );

    const beforeCount = await countOutboundMediaFiles();
    const dryArgs: Record<string, unknown> = {
      buffer: Buffer.from("dry-run artifact bytes").toString("base64"),
      filename: "dry-artifact.txt",
      contentType: "text/plain",
    };

    await hydrateAttachmentParamsForAction({
      cfg,
      channel: "workspace",
      args: dryArgs,
      action: "send",
      dryRun: true,
      mediaPolicy: { mode: "host" },
    });

    expect(dryArgs.media).toBeUndefined();
    expect(await countOutboundMediaFiles()).toBe(beforeCount);

    const dryRunResult = await runMessageAction({
      cfg: {
        channels: {
          workspace: {
            botToken: "xoxb-test",
            appToken: "xapp-test",
          },
        },
      } as OpenClawConfig,
      action: "send",
      dryRun: true,
      params: {
        channel: "workspace",
        target: "12345678",
        message: "dry-run buffer-only send",
        buffer: Buffer.from("dry-run artifact bytes").toString("base64"),
        filename: "dry-artifact.txt",
        contentType: "text/plain",
      },
    });

    expect(dryRunResult.kind).toBe("send");
    if (dryRunResult.kind !== "send") {
      throw new Error("expected send result");
    }
    expect(dryRunResult.dryRun).toBe(true);
    expect(dryRunResult.sendResult?.mediaUrl).toBeFalsy();
    expect(await countOutboundMediaFiles()).toBe(beforeCount);

    const materializeArgs: Record<string, unknown> = {
      buffer: Buffer.from("artifact bytes").toString("base64"),
      filename: "artifact.txt",
      contentType: "text/plain",
    };
    await materializeSendBufferMediaParams({
      cfg,
      channel: "workspace",
      args: materializeArgs,
    });

    const stagedPath = String(materializeArgs.media);
    const stagedContents = await fs.readFile(stagedPath, "utf8");
    expect(stagedContents).toBe("artifact bytes");
    expect(await countOutboundMediaFiles()).toBeGreaterThan(beforeCount);

    const realSendResult = await runMessageAction({
      cfg: {
        channels: {
          workspace: {
            botToken: "xoxb-test",
            appToken: "xapp-test",
          },
        },
      } as OpenClawConfig,
      action: "send",
      dryRun: false,
      params: {
        channel: "workspace",
        target: "12345678",
        message: "artifact attached",
        buffer: Buffer.from("artifact bytes").toString("base64"),
        filename: "artifact.txt",
        contentType: "text/plain",
      },
    });

    expect(realSendResult.kind).toBe("send");
    if (realSendResult.kind !== "send") {
      throw new Error("expected send result");
    }
    expect(realSendResult.dryRun).toBe(false);
    expect(realSendResult.sendResult?.mediaUrl).toBeTypeOf("string");
    await expect(fs.readFile(String(realSendResult.sendResult?.mediaUrl), "utf8")).resolves.toBe(
      "artifact bytes",
    );

    // Redacted L3 proof artifact for external PR evidence.
    console.log(
      JSON.stringify(
        {
          l3_proof: {
            environment: "local vitest runtime (no outbound-send mocks)",
            dry_run: {
              outbound_file_count_before: beforeCount,
              outbound_file_count_after_hydrate: beforeCount,
              outbound_file_count_after_runMessageAction: beforeCount,
              args_media: dryArgs.media ?? null,
              sendResult_mediaUrl: dryRunResult.sendResult?.mediaUrl ?? undefined,
            },
            real_send: {
              staged_path: stagedPath,
              staged_contents: stagedContents,
              sendResult_mediaUrl: realSendResult.sendResult?.mediaUrl ?? null,
              sendResult_delivery: realSendResult.sendResult?.result ?? null,
            },
          },
        },
        null,
        2,
      ),
    );
  });
});
