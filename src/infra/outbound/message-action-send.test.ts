// Covers plugin-dispatched message actions, target resolution, dry-run behavior,
// and plugin tool-result extraction.
import fs from "node:fs/promises";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { jsonResult } from "../../agents/tools/common.js";
import type { ChannelPlugin } from "../../channels/plugins/types.public.js";
import type { OpenClawConfig } from "../../config/config.js";
import { setActivePluginRegistry } from "../../plugins/runtime.js";
import { createTestRegistry } from "../../test-utils/channel-plugins.js";
import {
  createActionPluginBase,
  createGatewayActionPlugin,
  messageActionRunnerMocks as mocks,
  resetMessageActionRunnerMocks,
  runMessageAction as runAction,
  setMessageActionTestPlugin as setTestPlugin,
  useActionHubPluginFixture,
  readFirstPluginCall,
  readMockCallArg,
  readRecordField,
  expectRecordFields,
  createEnabledMessageActionConfig,
} from "./message-action-runner.test-helpers.js";
import { ensureOutboundSessionEntry, resolveOutboundSessionRoute } from "./outbound-session.js";

const cli = { clientName: "cli", mode: "cli" } as const;

type SendInput = Omit<Parameters<typeof runAction>[0], "action" | "cfg" | "params"> & {
  cfg?: OpenClawConfig;
  params: Record<string, unknown> & { channel: string };
};
function runMessageAction({ cfg, ...input }: SendInput) {
  return runAction({
    action: "send",
    dryRun: false,
    cfg: cfg ?? createEnabledMessageActionConfig(input.params.channel),
    ...input,
  });
}
function registerGatewayChat(handleAction = vi.fn(async () => jsonResult({ ok: true }))) {
  setTestPlugin(
    createGatewayActionPlugin({
      pluginId: "gatewaychat",
      label: "Gateway Chat",
      blurb: "Gateway Chat send test plugin.",
      actions: ["send"],
      messaging: { targetResolver: { looksLikeId: () => true } },
      handleAction,
    }),
    "gatewaychat",
  );
}
function gatewayMessageParams() {
  const call = readMockCallArg(mocks.callGatewayLeastPrivilege, "gateway least privilege call");
  return readRecordField(
    readRecordField(call, "params", "gateway call params"),
    "params",
    "gateway message params",
  );
}

describe("runMessageAction plugin dispatch", () => {
  beforeEach(() => {
    resetMessageActionRunnerMocks();
  });
  describe("alias-based plugin action dispatch", () => {
    useActionHubPluginFixture();
    it("mirrors an inherited reply through its canonical root", async () => {
      const sessionKey = "agent:main:forum:channel:123:thread:root-42";
      vi.mocked(resolveOutboundSessionRoute).mockResolvedValueOnce({
        sessionKey,
        baseSessionKey: "base",
        peer: { id: "123", kind: "channel" },
        chatType: "channel",
        from: "forum:123",
        to: "forum:123",
        threadId: "root-42",
      });
      setTestPlugin(
        createGatewayActionPlugin({
          pluginId: "forum",
          label: "Forum",
          blurb: "Thread routing test plugin.",
          actions: ["send"],
          gatewayActions: [],
          messaging: { targetResolver: { looksLikeId: () => true } },
          threading: {
            resolveAutoThreadId: ({ replyToId }) => (replyToId ? undefined : "root-42"),
            resolveReplyTransport: ({ threadId, replyToId, replyToIsExplicit }) => ({
              replyToId: replyToIsExplicit || threadId == null ? replyToId : String(threadId),
              threadId: threadId ?? null,
            }),
          },
          handleAction: vi.fn(async () => jsonResult({ ok: true })),
        }),
        "forum",
      );
      mocks.executeSendAction.mockResolvedValueOnce({ handledBy: "core", payload: { ok: true } });

      await runMessageAction({
        params: { channel: "forum", target: "forum:123", message: "Reply" },
        agentId: "main",
        toolContext: {
          currentChannelId: "forum:123",
          currentChannelProvider: "forum",
          currentMessageId: "child-777",
          currentThreadTs: "42",
          replyToMode: "all",
        },
      });

      expect(resolveOutboundSessionRoute).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({ replyToId: "root-42", threadId: "root-42" }),
      );
      expect(mocks.executeSendAction).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({
          reply: { replyToId: "root-42", source: "implicit", mode: "all" },
          threadId: "root-42",
          ctx: expect.objectContaining({
            params: expect.objectContaining({
              replyTo: "root-42",
              threadId: "root-42",
              __sessionKey: sessionKey,
              __agentId: "main",
            }),
            mirror: expect.objectContaining({ sessionKey }),
          }),
        }),
      );
    });
    it.each([
      ["suppressed", { status: "suppressed", reason: "cancelled_by_message_sending_hook" }, false],
      [
        "failed with an attempt ID",
        { ok: false, error: "send failed", messageId: "attempt-id" },
        false,
      ],
      ["dry-run", { ok: true, dryRun: true, messageId: "dry-run-id" }, false],
      [
        "explicit partial delivery",
        {
          ok: false,
          error: "second part failed",
          sentBeforeError: true,
          messageId: "partial-receipt",
        },
        true,
      ],
      ["successful delivery", { ok: true, messageId: "sent-1" }, true],
    ] as const)("handles Gateway-relayed %s receipts", async (_name, receipt, accepted) => {
      vi.mocked(resolveOutboundSessionRoute).mockResolvedValueOnce({
        sessionKey: "agent:main:gatewaychat:direct:user-123",
        baseSessionKey: "agent:main:gatewaychat:direct:user-123",
        peer: { kind: "direct", id: "user-123" },
        chatType: "direct",
        from: "gatewaychat:user-123",
        to: "user-123",
      });
      registerGatewayChat(vi.fn());
      mocks.callGatewayLeastPrivilege.mockResolvedValue(receipt);
      const result = await runMessageAction({
        params: { channel: "gatewaychat", target: "user-123", message: "omitted" },
        agentId: "main",
        gateway: cli,
      });
      expect(result.payload).toEqual(receipt);
      expect(ensureOutboundSessionEntry).toHaveBeenCalledTimes(accepted ? 1 : 0);
    });
    it.each(["gatewaychat", "gatewaydeliver"])(
      "preserves data URL bytes and MIME through %s",
      async (channel) => {
        const buffer = "data:application/octet-stream;base64,SGVsbG8=";
        const mediaUrl = "buffer://message-send/attachment";
        const filename = channel === "gatewaychat" ? "gateway.txt" : "delivery.txt";
        if (channel === "gatewaychat") {
          registerGatewayChat();
          mocks.callGatewayLeastPrivilege.mockResolvedValue({
            ok: true,
            messageId: "gw-send-buffer",
          });
        } else {
          setTestPlugin(
            {
              ...createActionPluginBase(
                channel,
                "Gateway Deliver",
                "Gateway delivery-mode send test plugin.",
              ),
              messaging: { targetResolver: { looksLikeId: () => true } },
              outbound: { deliveryMode: "gateway" },
            },
            channel,
          );
          mocks.executeSendAction.mockResolvedValueOnce({
            handledBy: "core",
            payload: { ok: true },
            sendResult: { channel, to: "user-123", via: "gateway", mediaUrl },
          });
        }
        await runMessageAction({
          params: { channel, target: "user-123", buffer, filename, mimeType: "text/plain" },
          gateway: cli,
        });
        const expected = {
          mediaUrl,
          mediaUrls: [mediaUrl],
          buffer,
          filename,
          contentType: "text/plain",
        };
        if (channel === "gatewaychat") {
          expectRecordFields(
            gatewayMessageParams(),
            { to: "user-123", media: mediaUrl, ...expected },
            "gateway message params",
          );
          expect(mocks.executeSendAction).not.toHaveBeenCalled();
        } else {
          expectRecordFields(
            readMockCallArg(mocks.executeSendAction, "execute send call"),
            expected,
            "execute send call",
          );
        }
      },
    );

    it("stages workspace-reader media before gateway dispatch", async () => {
      registerGatewayChat();
      mocks.callGatewayLeastPrivilege.mockResolvedValue({
        ok: true,
        messageId: "gw-sandbox-media",
      });
      const workspaceReadFile = vi.fn(async () => Buffer.from("remote chart"));
      mocks.loadWebMedia.mockImplementation(async (mediaUrl, maxBytesOrOptions) => {
        const options =
          typeof maxBytesOrOptions === "object" && maxBytesOrOptions !== null
            ? maxBytesOrOptions
            : undefined;
        const readFile = options?.readFile;
        if (!readFile) {
          throw new Error("expected gateway staging media reader");
        }
        return {
          buffer: await readFile(mediaUrl),
          contentType: "text/plain",
          fileName: "chart.txt",
          kind: "document",
        };
      });

      await runMessageAction({
        params: {
          channel: "gatewaychat",
          target: "user-123",
          path: "/sandbox/chart.txt",
          filePath: "/sandbox/chart.txt",
          fileUrl: "/sandbox/chart.txt",
          attachments: [
            {
              type: "file",
              path: "/sandbox/chart.txt",
              fileUrl: "/sandbox/chart.txt",
              name: "chart.txt",
              mimeType: "text/plain",
            },
          ],
        },
        sandboxRoot: "/host-mirror",
        sandboxContainerWorkdir: "/sandbox",
        workspaceMediaAccess: {
          localRoots: ["/host-mirror", "/sandbox"],
          readFile: workspaceReadFile,
          workspaceDir: "/host-mirror",
        },
        gateway: cli,
      });

      const messageParams = gatewayMessageParams();
      const stagedPath = String(messageParams.media);
      expect(stagedPath).not.toBe("/sandbox/chart.txt");
      expect(messageParams.mediaUrl).toBe(stagedPath);
      expect(messageParams.mediaUrls).toEqual([stagedPath]);
      expect(messageParams.attachments).toEqual([
        {
          type: "file",
          path: stagedPath,
          name: "chart.txt",
          mimeType: "text/plain",
        },
      ]);
      expect(messageParams).not.toHaveProperty("path");
      expect(messageParams).not.toHaveProperty("filePath");
      expect(messageParams).not.toHaveProperty("fileUrl");
      await expect(fs.readFile(stagedPath, "utf8")).resolves.toBe("remote chart");
      expect(workspaceReadFile).toHaveBeenCalled();
    });

    it("applies TTS before gateway-executed plugin sends", async () => {
      registerGatewayChat(vi.fn(async () => jsonResult({ ok: true, local: true })));
      mocks.callGatewayLeastPrivilege.mockResolvedValue({
        ok: true,
        messageId: "gw-send-tts",
      });
      mocks.maybeApplyTtsToPayload.mockResolvedValueOnce({
        mediaUrl: "file:///tmp/openclaw-voice.ogg",
        audioAsVoice: true,
        spokenText: "hello there",
      });

      await runMessageAction({
        cfg: {
          ...createEnabledMessageActionConfig("gatewaychat"),
          tts: { auto: "tagged" },
        } as OpenClawConfig,
        params: {
          channel: "gatewaychat",
          target: "user-123",
          message: "[[tts:text]]hello there[[/tts:text]]",
        },
        gateway: cli,
      });

      expectRecordFields(
        gatewayMessageParams(),
        {
          message: "",
          media: "file:///tmp/openclaw-voice.ogg",
          mediaUrl: "file:///tmp/openclaw-voice.ogg",
          asVoice: true,
          audioAsVoice: true,
        },
        "gateway message params",
      );
      expect(mocks.executeSendAction).not.toHaveBeenCalled();
    });
  });
  describe("presentation send routing", () => {
    const chart = (title: string, categories: string[], name: string, values: number[]) => ({
      blocks: [{ type: "chart", chartType: "line", title, categories, series: [{ name, values }] }],
    });
    const handleAction = vi.fn(
      async ({ cfg, params }: { cfg: OpenClawConfig; params: Record<string, unknown> }) => {
        const message = typeof params.message === "string" ? params.message : "";
        const responsePrefix = Object.values(cfg.channels ?? {}).find(
          (entry): entry is { responsePrefix?: string } =>
            typeof entry === "object" && entry !== null && "responsePrefix" in entry,
        )?.responsePrefix;
        const rawMessage =
          responsePrefix && message.startsWith(`${responsePrefix} `)
            ? message.slice(responsePrefix.length + 1)
            : message;
        let detectedCard = false;
        try {
          detectedCard = isRecord((JSON.parse(rawMessage) as { body?: unknown }).body);
        } catch {
          // Non-JSON text remains a normal plugin message.
        }
        return jsonResult({
          ok: true,
          presentation: params.presentation ?? null,
          message: params.message ?? null,
          detectedCard,
        });
      },
    );

    const cardPlugin: ChannelPlugin = {
      ...createActionPluginBase("cardchat", "Card Chat", "Card-only send test plugin."),
      actions: {
        describeMessageTool: () => ({ actions: ["send"], capabilities: ["presentation"] }),
        supportsAction: ({ action }) => action === "send",
        resolveExecutionMode: ({ action }) => (action === "send" ? "gateway" : "local"),
        handleAction,
      },
    };

    function registerLocalCardPlugin() {
      setTestPlugin(
        {
          ...cardPlugin,
          actions: { ...cardPlugin.actions, resolveExecutionMode: () => "local" },
          outbound: {
            deliveryMode: "direct",
            sendText: async () => ({ channel: "cardchat", messageId: "msg-test" }),
          },
        },
        "cardchat",
      );
    }

    beforeEach(() => {
      setTestPlugin(cardPlugin, "cardchat");
      handleAction.mockClear();
    });

    afterEach(() => {
      setActivePluginRegistry(createTestRegistry([]));
      vi.clearAllMocks();
    });

    it("keeps presentation-only sends on action-only gateway plugins", async () => {
      const presentation = {
        blocks: [{ type: "text", text: "Presentation-only payload" }],
      };
      mocks.callGatewayLeastPrivilege.mockResolvedValueOnce({ ok: true, messageId: "card-1" });

      const result = await runMessageAction({
        params: {
          channel: "cardchat",
          target: "channel:test-card",
          presentation,
        },
        gateway: cli,
      });

      expect(result).toMatchObject({ kind: "send", handledBy: "plugin" });
      expect(handleAction).not.toHaveBeenCalled();
      expect(mocks.executeSendAction).not.toHaveBeenCalled();
      const gatewayActionParams = gatewayMessageParams();
      expect(gatewayActionParams).not.toHaveProperty("message");
      expectRecordFields(gatewayActionParams, { presentation }, "gateway action params");
    });

    it("omits a blank shared-schema location from gateway-routed sends", async () => {
      const cfg = {
        ...createEnabledMessageActionConfig("cardchat"),
        messages: { responsePrefix: "[Nexus]" },
      } as OpenClawConfig;
      mocks.callGatewayLeastPrivilege.mockResolvedValueOnce({
        ok: true,
        messageId: "card-location",
      });

      const result = await runMessageAction({
        cfg,
        params: {
          channel: "cardchat",
          target: "channel:test-card",
          message: "hello",
          location: "",
        },
        gateway: cli,
      });

      expect(result).toMatchObject({ kind: "send", handledBy: "plugin" });
      expect(handleAction).not.toHaveBeenCalled();
      const gatewayActionParams = gatewayMessageParams();
      expect(gatewayActionParams).not.toHaveProperty("location");
    });

    it("routes local chart presentations through core delivery", async () => {
      const sourceSessionKey = "agent:main:cardchat:direct:restricted-creator";
      const presentation = chart("Deployments", ["Mon", "Tue"], "Production", [2, 3]);
      mocks.executeSendAction.mockResolvedValueOnce({
        handledBy: "core",
        payload: { ok: true },
      });
      vi.mocked(resolveOutboundSessionRoute).mockResolvedValueOnce({
        sessionKey: "agent:main:cardchat:channel:test-card",
        baseSessionKey: "agent:main:cardchat:channel:test-card",
        peer: { kind: "channel", id: "test-card" },
        chatType: "channel",
        from: "cardchat:channel:test-card",
        to: "channel:test-card",
      });
      registerLocalCardPlugin();

      const result = await runMessageAction({
        params: {
          channel: "cardchat",
          target: "channel:test-card",
          message: "Deployment trend",
          presentation,
        },
        gateway: cli,
        agentId: "main",
        sessionKey: sourceSessionKey,
        suppressTranscriptMirror: true,
      });

      expect(result).toMatchObject({ kind: "send", handledBy: "core" });
      expect(handleAction).not.toHaveBeenCalled();
      expect(mocks.callGatewayLeastPrivilege).not.toHaveBeenCalled();
      const executeCall = readMockCallArg(mocks.executeSendAction, "execute send call");
      expectRecordFields(executeCall, { message: "Deployment trend" }, "execute send call");
      const executeContext = readRecordField(executeCall, "ctx", "execute send context");
      expectRecordFields(executeContext, { conversationType: "channel" }, "execute send context");
      expect(executeContext.mirror).toBeUndefined();
      expectRecordFields(
        readRecordField(executeCall, "payload", "execute send payload"),
        { text: "Deployment trend", presentation },
        "execute send payload",
      );
      expect(ensureOutboundSessionEntry).toHaveBeenCalledWith(
        expect.objectContaining({ sourceSessionKey }),
      );
    });

    it.each([
      ["model-authored message-tool sends", "message-tool" as const, "caller"],
      ["operator CLI and gateway sends", undefined, undefined],
    ])("marks the delivery retry owner for %s", async (_label, actionOrigin, expected) => {
      const presentation = chart("Trend", ["Mon"], "Prod", [1]);
      mocks.executeSendAction.mockResolvedValueOnce({ handledBy: "core", payload: { ok: true } });
      registerLocalCardPlugin();

      await runMessageAction({
        ...(actionOrigin ? { actionOrigin } : {}),
        params: {
          channel: "cardchat",
          target: "channel:test-card",
          message: "Deployment trend",
          presentation,
        },
        gateway: cli,
        agentId: "main",
        suppressTranscriptMirror: true,
      });

      const executeCall = readMockCallArg(mocks.executeSendAction, "execute send call");
      const executeContext = readRecordField(executeCall, "ctx", "execute send context");
      expect(executeContext.deliveryRetryOwner).toBe(expected);
    });

    it("keeps non-presentation sends on plugin-owned handling", async () => {
      const cardJson = JSON.stringify({
        body: {
          elements: [{ tag: "markdown", content: "Card body" }],
        },
      });
      const result = await runMessageAction({
        cfg: {
          channels: { cardchat: { enabled: true, responsePrefix: "[Nexus]" } },
        } as OpenClawConfig,
        params: {
          channel: "cardchat",
          target: "channel:test-card",
          message: cardJson,
        },
      });

      expect(result).toMatchObject({
        kind: "send",
        handledBy: "plugin",
        payload: { ok: true, detectedCard: true },
      });
      const pluginParams = readRecordField(readFirstPluginCall(handleAction), "params", "params");
      expect(pluginParams.message).toBe(`[Nexus] ${cardJson}`);
    });
  });
});
