import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { awaitGateBeforeSettlement, createDeferred } from "../../../test/helpers/promise.js";
import type { ChannelOutboundContext } from "../../channels/plugins/outbound.types.js";
import type { ChannelPlugin } from "../../channels/plugins/types.public.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { runMessageAction } from "../../infra/outbound/message-action-runner.js";
import { resetPluginRuntimeStateForTest, setActivePluginRegistry } from "../../plugins/runtime.js";
import {
  createChannelTestPluginBase,
  createTestRegistry,
} from "../../test-utils/channel-plugins.js";
import { withTempDir } from "../../test-utils/temp-dir.js";
import { createSandboxFsBridge } from "../sandbox/fs-bridge.js";
import type { SandboxFsBridge } from "../sandbox/fs-bridge.types.js";
import { createRemoteShellSandboxFsBridge } from "../sandbox/remote-fs-bridge.js";
import { createLocalRemoteShellScriptRunner } from "../sandbox/remote-fs-bridge.test-helpers.js";
import { createSandboxTestContext } from "../sandbox/test-fixtures.js";
import { runWithAgentWorkspaceReadiness } from "../workspace-readiness.js";
import { jsonResult } from "./common.js";
import { createMessageTool } from "./message-tool-execution.js";

const channel = "sandboxchat" as ChannelPlugin["id"];
const cfg = { channels: { sandboxchat: { enabled: true } } } as OpenClawConfig;

function createSandboxContext(workspaceDir: string) {
  return createSandboxTestContext({
    overrides: {
      backendId: "test",
      workspaceDir,
      agentWorkspaceDir: workspaceDir,
      containerWorkdir: "/sandbox",
    },
  });
}

function createRemoteBridge(params: {
  hostMirrorDir: string;
  remoteWorkspaceDir: string;
}): SandboxFsBridge {
  return createRemoteShellSandboxFsBridge({
    sandbox: createSandboxContext(params.hostMirrorDir),
    runtime: {
      remoteWorkspaceDir: params.remoteWorkspaceDir,
      remoteAgentWorkspaceDir: params.remoteWorkspaceDir,
      runRemoteShellScript: createLocalRemoteShellScriptRunner(),
    },
  });
}

function registerAttachmentPlugin(
  id: ChannelPlugin["id"],
  messageId: string,
  options: {
    sendMedia?: NonNullable<ChannelPlugin["outbound"]>["sendMedia"];
    actions?: ChannelPlugin["actions"];
  },
) {
  const plugin: ChannelPlugin = {
    ...createChannelTestPluginBase({
      id,
      capabilities: { chatTypes: ["direct"], media: true },
      config: { isConfigured: () => true, resolveAccount: () => ({ enabled: true }) },
    }),
    messaging: {
      normalizeTarget: (raw) => raw.trim() || undefined,
      targetResolver: { looksLikeId: (raw) => raw.trim().length > 0 },
    },
    outbound: {
      deliveryMode: "direct",
      resolveTarget: ({ to }) => ({ ok: true, to: to ?? "recipient" }),
      sendText: async () => ({ channel: id, messageId }),
      ...(options.sendMedia ? { sendMedia: options.sendMedia } : {}),
    },
    ...(options.actions ? { actions: options.actions } : {}),
  };
  setActivePluginRegistry(createTestRegistry([{ pluginId: id, source: "test", plugin }]));
  return id;
}

afterEach(() => {
  resetPluginRuntimeStateForTest();
  vi.unstubAllEnvs();
});

async function remoteFileBridge(
  hostMirrorDir: string,
  stateDir: string,
  file: string,
  contents: string,
) {
  const remoteWorkspaceDir = path.join(stateDir, "remote-workspace");
  await fs.mkdir(remoteWorkspaceDir, { recursive: true });
  await fs.writeFile(path.join(remoteWorkspaceDir, file), contents);
  return createRemoteBridge({ hostMirrorDir, remoteWorkspaceDir });
}

it.each([
  {
    name: "remote-only bridge with an empty host mirror",
    createBridge: (host: string, state: string) =>
      remoteFileBridge(host, state, "chart.txt", "remote chart"),
    file: "chart.txt",
    expectedBytes: "remote chart",
    allowed: true,
  },
  {
    name: "standard mirrored sandbox bridge",
    createBridge: async (hostMirrorDir: string) => {
      await fs.writeFile(path.join(hostMirrorDir, "chart.txt"), "mirrored chart");
      return createSandboxFsBridge({
        sandbox: {
          ...createSandboxContext(hostMirrorDir),
          backend: {
            // Only emulate metadata lookup; retain the pinned host-file read.
            runShellCommand: async ({ script, args }) => {
              expect(script).toContain('readlink -n -f -- "$cursor"');
              expect(args).toEqual(["/sandbox/chart.txt", "0", "0"]);
              return {
                stdout: Buffer.from("/sandbox/chart.txt\n"),
                stderr: Buffer.alloc(0),
                code: 0,
              };
            },
          },
        },
      });
    },
    file: "chart.txt",
    expectedBytes: "mirrored chart",
    allowed: true,
  },
  {
    name: "denied workspace read policy",
    createBridge: (host: string, state: string) =>
      remoteFileBridge(host, state, "private.txt", "private"),
    file: "private.txt",
    expectedBytes: "private",
    allowed: false,
  },
])("gates media through the $name", async ({ createBridge, file, expectedBytes, allowed }) => {
  await withTempDir("message-tool-sandbox-media-", async (tempDir) => {
    const stateDir = await fs.realpath(tempDir);
    const hostMirrorDir = path.join(stateDir, "host-mirror");
    await fs.mkdir(hostMirrorDir, { recursive: true });
    const bridge = await createBridge(hostMirrorDir, stateDir);
    const bridgeReadFile = vi.spyOn(bridge, "readFile");
    const deliveredBytes: Buffer[] = [];
    const denied = "sandbox media access was denied";
    const sendMedia = vi.fn(async (ctx: ChannelOutboundContext) => {
      if (!ctx.mediaAccess?.readFile || !ctx.mediaUrl) {
        throw new Error(
          allowed ? "sandbox media access was not delivered to the channel adapter" : denied,
        );
      }
      deliveredBytes.push(await ctx.mediaAccess.readFile(ctx.mediaUrl));
      return { channel, messageId: "sandbox-media-1" };
    });
    registerAttachmentPlugin(channel, "sandbox-text-1", { sendMedia });
    const config: OpenClawConfig = allowed
      ? cfg
      : { ...cfg, tools: { allow: ["message"], deny: ["read"] } };
    const tool = createMessageTool({
      config,
      getRuntimeConfig: () => config,
      conversationReadOrigin: "direct-operator",
      sandboxRoot: hostMirrorDir,
      sandboxContainerWorkdir: "/sandbox",
      sandboxFsBridge: bridge,
      sandboxWorkspaceMediaReadAllowed: allowed,
      runMessageAction: (input) => runMessageAction({ ...input, skipQueue: true }),
    });
    const pending = tool.execute("sandbox-media-send", {
      action: "send",
      channel,
      target: "recipient",
      message: "chart ready",
      media: `/sandbox/${file}`,
    });
    if (allowed) {
      await pending;
      expect(deliveredBytes).toEqual([Buffer.from(expectedBytes)]);
    } else {
      await expect(pending).rejects.toThrow(denied);
      expect(bridgeReadFile).not.toHaveBeenCalled();
    }
    expect(sendMedia).toHaveBeenCalledTimes(1);
  });
});

function registerAttachmentActions(delivered: Record<string, unknown>[]) {
  return registerAttachmentPlugin("readinesschat", "readiness-text", {
    actions: {
      describeMessageTool: () => ({
        actions: ["send", "sendAttachment"],
        mediaSourceParams: ["asset"],
      }),
      supportsAction: ({ action }) => action === "send" || action === "sendAttachment",
      handleAction: async ({ params }) => {
        delivered.push({
          ...params,
          ...(typeof params.asset === "string"
            ? { buffer: (await fs.readFile(params.asset)).toString("base64") }
            : {}),
        });
        return jsonResult({ ok: true });
      },
    },
  });
}

it.each([
  { outcome: "ready", mediaKey: "media" },
  { outcome: "ready", mediaKey: "asset" },
  { outcome: "revoked", mediaKey: "media" },
] as const)(
  "gates $mediaKey on a retained execute callback and rechecks its $outcome owner",
  async ({ outcome, mediaKey }) => {
    await withTempDir("message-tool-workspace-ready-", async (tempDir) => {
      const workspaceDir = await fs.realpath(tempDir);
      vi.stubEnv("OPENCLAW_STATE_DIR", path.join(workspaceDir, "state"));
      const delivered: Record<string, unknown>[] = [];
      const messageChannel = registerAttachmentActions(delivered);
      const config: OpenClawConfig = {
        agents: { defaults: { workspace: workspaceDir } },
        channels: { readinesschat: { enabled: true } },
      };
      const waiting = createDeferred();
      const ready = createDeferred();
      let active = true;
      const assertCurrent = () => {
        if (!active) {
          throw new Error("workspace owner revoked");
        }
      };
      const waitUntilReady = vi.fn(() => {
        waiting.resolve();
        return ready.promise;
      });
      const tool = await runWithAgentWorkspaceReadiness(
        { sessionKey: "agent:main:attachment-readiness", waitUntilReady, assertCurrent },
        async () =>
          createMessageTool({
            config,
            getRuntimeConfig: () => config,
            agentSessionKey:
              mediaKey === "asset" ? "agent:main:source-policy" : "agent:main:attachment-readiness",
            runSessionKey: mediaKey === "asset" ? "agent:main:attachment-readiness" : undefined,
            workspaceDir,
            conversationReadOrigin: "direct-operator",
            runMessageAction: (input) => runMessageAction({ ...input, skipQueue: true }),
          }),
      );
      const media = path.join(workspaceDir, "assets/report.pdf");
      const pending = tool.execute("local-attachment", {
        action: "sendAttachment",
        channel: messageChannel,
        target: "recipient",
        [mediaKey]: media,
      });
      void pending.catch(() => {});
      try {
        await awaitGateBeforeSettlement(
          waiting.promise,
          pending,
          "Local attachment read did not wait for workspace preparation",
        );
        expect(delivered).toEqual([]);
        if (outcome === "ready") {
          for (const args of [
            { action: "send", message: "Text while checkout is pending." },
            { action: "send", media: "https://example.com/remote.pdf" },
            {
              action: "sendAttachment",
              buffer: Buffer.from("inline bytes").toString("base64"),
              filename: "inline.txt",
            },
          ]) {
            await tool.execute("independent-attachment", {
              channel: messageChannel,
              target: "recipient",
              ...args,
            });
          }
          expect(delivered).toHaveLength(3);
          expect(waitUntilReady).toHaveBeenCalledOnce();
          await fs.mkdir(path.dirname(media), { recursive: true });
          await fs.writeFile(media, "%PDF-1.4\nsynthetic report\n%%EOF");
          ready.resolve();
          await pending;
          expect(Buffer.from(String(delivered[3]?.buffer), "base64").toString()).toBe(
            "%PDF-1.4\nsynthetic report\n%%EOF",
          );
        } else {
          active = false;
          ready.resolve();
          await expect(pending).rejects.toThrow("workspace owner revoked");
          expect(delivered).toEqual([]);
        }
      } finally {
        ready.resolve();
        await pending.catch(() => {});
      }
    });
  },
);
