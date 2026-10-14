import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
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
const cfg = {
  channels: { sandboxchat: { enabled: true } },
} as OpenClawConfig;

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

function registerSandboxMediaPlugin(
  sendMedia: NonNullable<ChannelPlugin["outbound"]>["sendMedia"],
): void {
  const plugin: ChannelPlugin = {
    ...createChannelTestPluginBase({
      id: channel,
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
      sendText: async () => ({ channel, messageId: "sandbox-text-1" }),
      sendMedia,
    },
  };
  setActivePluginRegistry(createTestRegistry([{ pluginId: channel, source: "test", plugin }]));
}

describe("message tool sandbox attachments", () => {
  afterEach(() => {
    resetPluginRuntimeStateForTest();
    vi.unstubAllEnvs();
  });

  it.each([
    {
      name: "remote-only bridge with an empty host mirror",
      createBridge: async (hostMirrorDir: string, stateDir: string) => {
        const remoteWorkspaceDir = path.join(stateDir, "remote-workspace");
        await fs.mkdir(remoteWorkspaceDir, { recursive: true });
        await fs.writeFile(path.join(remoteWorkspaceDir, "chart.txt"), "remote chart");
        return createRemoteBridge({ hostMirrorDir, remoteWorkspaceDir });
      },
      expectedBytes: "remote chart",
    },
    {
      name: "standard mirrored sandbox bridge",
      createBridge: async (hostMirrorDir: string) => {
        await fs.writeFile(path.join(hostMirrorDir, "chart.txt"), "mirrored chart");
        return createSandboxFsBridge({
          sandbox: {
            ...createSandboxContext(hostMirrorDir),
            backend: {
              // This regular fixture file has no container-side aliases. Keep the
              // real pinned host read; only model the backend's metadata command.
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
      expectedBytes: "mirrored chart",
    },
  ])("delivers media through the $name", async ({ createBridge, expectedBytes }) => {
    await withTempDir("message-tool-sandbox-media-", async (tempDir) => {
      const stateDir = await fs.realpath(tempDir);
      const hostMirrorDir = path.join(stateDir, "host-mirror");
      await fs.mkdir(hostMirrorDir, { recursive: true });
      const bridge = await createBridge(hostMirrorDir, stateDir);
      const deliveredBytes: Buffer[] = [];
      const sendMedia = vi.fn(async (ctx: ChannelOutboundContext) => {
        const readFile = ctx.mediaAccess?.readFile;
        if (!readFile || !ctx.mediaUrl) {
          throw new Error("sandbox media access was not delivered to the channel adapter");
        }
        deliveredBytes.push(await readFile(ctx.mediaUrl));
        return { channel, messageId: "sandbox-media-1" };
      });
      registerSandboxMediaPlugin(sendMedia);

      const tool = createMessageTool({
        config: cfg,
        getRuntimeConfig: () => cfg,
        conversationReadOrigin: "direct-operator",
        sandboxRoot: hostMirrorDir,
        sandboxContainerWorkdir: "/sandbox",
        sandboxFsBridge: bridge,
        sandboxWorkspaceMediaReadAllowed: true,
        runMessageAction: (input) => runMessageAction({ ...input, skipQueue: true }),
      });

      await tool.execute("sandbox-media-send", {
        action: "send",
        channel,
        target: "recipient",
        message: "chart ready",
        media: "/sandbox/chart.txt",
      });

      expect(sendMedia).toHaveBeenCalledTimes(1);
      expect(deliveredBytes).toEqual([Buffer.from(expectedBytes)]);
    });
  });

  it("does not invoke the workspace bridge when effective read policy denies attachments", async () => {
    await withTempDir("message-tool-sandbox-media-denied-", async (tempDir) => {
      const stateDir = await fs.realpath(tempDir);
      const hostMirrorDir = path.join(stateDir, "host-mirror");
      const remoteWorkspaceDir = path.join(stateDir, "remote-workspace");
      await fs.mkdir(hostMirrorDir, { recursive: true });
      await fs.mkdir(remoteWorkspaceDir, { recursive: true });
      await fs.writeFile(path.join(remoteWorkspaceDir, "private.txt"), "private");
      const bridge = createRemoteBridge({ hostMirrorDir, remoteWorkspaceDir });
      const bridgeReadFile = vi.spyOn(bridge, "readFile");
      const sendMedia = vi.fn(async (ctx: ChannelOutboundContext) => {
        if (!ctx.mediaAccess?.readFile || !ctx.mediaUrl) {
          throw new Error("sandbox media access was denied");
        }
        await ctx.mediaAccess.readFile(ctx.mediaUrl);
        return { channel, messageId: "sandbox-media-denied" };
      });
      registerSandboxMediaPlugin(sendMedia);
      const deniedCfg = {
        channels: { sandboxchat: { enabled: true } },
        tools: { allow: ["message"], deny: ["read"] },
      } as OpenClawConfig;
      const tool = createMessageTool({
        config: deniedCfg,
        getRuntimeConfig: () => deniedCfg,
        conversationReadOrigin: "direct-operator",
        sandboxRoot: hostMirrorDir,
        sandboxContainerWorkdir: "/sandbox",
        sandboxFsBridge: bridge,
        sandboxWorkspaceMediaReadAllowed: false,
        runMessageAction: (input) => runMessageAction({ ...input, skipQueue: true }),
      });

      await expect(
        tool.execute("sandbox-media-denied", {
          action: "send",
          channel,
          target: "recipient",
          message: "send private file",
          media: "/sandbox/private.txt",
        }),
      ).rejects.toThrow("sandbox media access was denied");
      expect(sendMedia).toHaveBeenCalledTimes(1);
      expect(bridgeReadFile).not.toHaveBeenCalled();
    });
  });
});

describe("message tool captured workspace readiness", () => {
  afterEach(() => {
    resetPluginRuntimeStateForTest();
    vi.unstubAllEnvs();
  });

  function registerAttachmentActions(delivered: Record<string, unknown>[]) {
    const id = "readinesschat" as ChannelPlugin["id"];
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
        sendText: async () => ({ channel: id, messageId: "readiness-text" }),
      },
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
    };
    setActivePluginRegistry(createTestRegistry([{ pluginId: id, source: "test", plugin }]));
    return id;
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
          {
            sessionKey: "agent:main:attachment-readiness",
            waitUntilReady,
            assertCurrent,
          },
          async () =>
            createMessageTool({
              config,
              getRuntimeConfig: () => config,
              agentSessionKey:
                mediaKey === "asset"
                  ? "agent:main:source-policy"
                  : "agent:main:attachment-readiness",
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
});
