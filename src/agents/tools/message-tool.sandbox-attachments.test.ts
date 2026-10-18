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

async function createRemoteBridge(hostMirrorDir: string, stateDir: string, contents: string) {
  const remoteWorkspaceDir = path.join(stateDir, "remote-workspace");
  await fs.mkdir(remoteWorkspaceDir, { recursive: true });
  await fs.writeFile(path.join(remoteWorkspaceDir, "chart.txt"), contents);
  return createRemoteShellSandboxFsBridge({
    sandbox: createSandboxContext(hostMirrorDir),
    runtime: {
      remoteWorkspaceDir,
      remoteAgentWorkspaceDir: remoteWorkspaceDir,
      runRemoteShellScript: createLocalRemoteShellScriptRunner(),
    },
  });
}

function registerAttachmentPlugin(
  id: ChannelPlugin["id"],
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
      sendText: async () => ({ channel: id, messageId: `${id}-text` }),
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

function createMirroredBridge(hostMirrorDir: string) {
  return createSandboxFsBridge({
    sandbox: {
      ...createSandboxContext(hostMirrorDir),
      backend: {
        // Only emulate metadata lookup; retain the pinned host-file read.
        runShellCommand: async ({ script, args }) => {
          expect(script).toContain('readlink -n -f -- "$cursor"');
          expect(args).toEqual(["/sandbox/chart.txt", "0", "0"]);
          return { stdout: Buffer.from("/sandbox/chart.txt\n"), stderr: Buffer.alloc(0), code: 0 };
        },
      },
    },
  });
}

it.each([
  ["remote-only bridge with an empty host mirror", false, true],
  ["standard mirrored sandbox bridge", true, true],
  ["denied workspace read policy", false, false],
] as const)("gates media through the %s", async (_name, mirrored, allowed) => {
  await withTempDir("message-tool-sandbox-media-", async (tempDir) => {
    const stateDir = await fs.realpath(tempDir);
    const hostMirrorDir = path.join(stateDir, "host-mirror");
    await fs.mkdir(hostMirrorDir, { recursive: true });
    const expectedBytes = mirrored ? "mirrored chart" : "remote chart";
    if (mirrored) {
      await fs.writeFile(path.join(hostMirrorDir, "chart.txt"), expectedBytes);
    }
    const bridge = mirrored
      ? createMirroredBridge(hostMirrorDir)
      : await createRemoteBridge(hostMirrorDir, stateDir, expectedBytes);
    const bridgeReadFile = vi.spyOn(bridge, "readFile");
    const deliveredBytes: Buffer[] = [];
    const denied = "sandbox media access was denied";
    const sendMedia = vi.fn(async (ctx: ChannelOutboundContext) => {
      if (!ctx.mediaAccess?.readFile || !ctx.mediaUrl) {
        throw new Error(denied);
      }
      deliveredBytes.push(await ctx.mediaAccess.readFile(ctx.mediaUrl));
      return { channel, messageId: "sandbox-media-1" };
    });
    registerAttachmentPlugin(channel, { sendMedia });
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
      media: "/sandbox/chart.txt",
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
  return registerAttachmentPlugin("readinesschat", {
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
  ["media", "ready"],
  ["asset", "ready"],
  ["media", "revoked"],
] as const)("gates retained %s execute against a %s workspace owner", async (mediaKey, outcome) => {
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
    const sessionKey = "agent:main:attachment-readiness";
    const contents = "%PDF-1.4\nsynthetic report\n%%EOF";
    const permission = new AbortController();
    const waitUntilReady = vi.fn(() => {
      waiting.resolve();
      return ready.promise;
    });
    const tool = await runWithAgentWorkspaceReadiness(
      { sessionKey, waitUntilReady, assertCurrent: () => permission.signal.throwIfAborted() },
      async () =>
        createMessageTool({
          config,
          getRuntimeConfig: () => config,
          agentSessionKey: mediaKey === "asset" ? "agent:main:source-policy" : sessionKey,
          runSessionKey: mediaKey === "asset" ? sessionKey : undefined,
          workspaceDir,
          conversationReadOrigin: "direct-operator",
          runMessageAction: (input) => runMessageAction({ ...input, skipQueue: true }),
        }),
    );
    const execute = (id: string, params: Record<string, unknown>) =>
      tool.execute(id, { channel: messageChannel, target: "recipient", ...params });
    const media = path.join(workspaceDir, "assets/report.pdf");
    const pending = execute("local-attachment", {
      action: "sendAttachment",
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
          await execute("independent-attachment", args);
        }
        expect(delivered).toHaveLength(3);
        expect(waitUntilReady).toHaveBeenCalledOnce();
        await fs.mkdir(path.dirname(media), { recursive: true });
        await fs.writeFile(media, contents);
        ready.resolve();
        await pending;
        expect(Buffer.from(String(delivered[3]?.buffer), "base64").toString()).toBe(contents);
      } else {
        permission.abort(new Error("workspace owner revoked"));
        ready.resolve();
        await expect(pending).rejects.toThrow("workspace owner revoked");
        expect(delivered).toEqual([]);
      }
    } finally {
      ready.resolve();
      await pending.catch(() => {});
    }
  });
});
