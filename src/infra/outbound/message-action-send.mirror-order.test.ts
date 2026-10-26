// Failed sends must not rewrite the main session's route or mint a conversation identity.
import path from "node:path";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { withinTest } from "../../../test/helpers/promise.js";
import { createEnteredGate } from "../../agents/entered-gate.test-support.js";
import { jsonResult } from "../../agents/tools/common.js";
import type { ChannelPlugin } from "../../channels/plugins/types.public.js";
import type { OpenClawConfig } from "../../config/config.js";
import {
  loadExactSessionEntry,
  loadTranscriptEventsSync,
  upsertSessionEntryCore,
} from "../../config/sessions/session-accessor.js";
import { isCanonicalSessionTranscriptEntry } from "../../config/sessions/transcript-tree.js";
import { withSessionTranscriptWriteAssertion } from "../../config/sessions/transcript-write-context.js";
import { setActivePluginRegistry } from "../../plugins/runtime.js";
import {
  captureGatewayRootWorkReleaseObserver,
  runWithGatewayIndependentRootWorkAdmission,
} from "../../process/gateway-work-admission.js";
import { withSessionTurn } from "../../sessions/session-controller.admission.js";
import {
  createChannelTestPluginBase,
  createTestRegistry,
} from "../../test-utils/channel-plugins.js";
import { useSessionStoreTempDirs } from "../../test-utils/session-state-cleanup.js";
import { sessionDeliveryOrigin } from "../../utils/delivery-context.read.js";
import { normalizeSessionDeliveryState } from "../../utils/delivery-context.shared.js";
import { GATEWAY_CLIENT_MODES, GATEWAY_CLIENT_NAMES } from "../../utils/message-channel.js";
import { runMessageAction } from "./message-action-runner.js";

vi.mock("../../tts/tts.runtime.js", () => ({
  maybeApplyTtsToPayload: vi.fn(async (params: { payload: unknown }) => params.payload),
}));

const MAIN_SESSION_KEY = "agent:main:main";
const discordOrigin = { provider: "discord", from: "discord:operator" };

describe("outbound mirror route ordering", () => {
  const sessionDirs = useSessionStoreTempDirs(afterAll, "openclaw-mirror-order-");
  let storePath: string;
  let cfg: OpenClawConfig;
  const handleAction = vi.fn();
  const sendMedia = vi.fn();
  let executionMode: "local" | "gateway" = "local";
  const transcriptScope = () => ({
    agentId: "main",
    sessionKey: MAIN_SESSION_KEY,
    sessionId: "main-session",
    storePath,
  });
  const mainSessionOrigin = () =>
    sessionDeliveryOrigin(loadExactSessionEntry(transcriptScope())?.entry);
  const send = (params: Record<string, unknown> = { to: "user:12345", message: "hi" }) =>
    runMessageAction({
      cfg,
      action: "send",
      params: { channel: "testchat", ...params },
      agentId: "main",
      dryRun: false,
    });

  beforeEach(async () => {
    storePath = path.join(sessionDirs.make(), "sessions.json");
    cfg = {
      session: { store: storePath },
      channels: { testchat: { enabled: true } },
    } as OpenClawConfig;
    handleAction.mockReset();
    sendMedia.mockReset();
    const plugin: ChannelPlugin = {
      ...createChannelTestPluginBase({ id: "testchat" }),
      config: {
        listAccountIds: () => ["default"],
        resolveAccount: () => ({ enabled: true }),
        isConfigured: () => true,
      },
      actions: {
        describeMessageTool: () => ({ actions: ["send"] }),
        supportsAction: ({ action }) => action === "send",
        resolveExecutionMode: () => executionMode,
        handleAction,
      },
      outbound: {
        deliveryMode: "direct",
        sendMedia,
        // The plugin action path above owns the send; core delivery must not run.
        sendText: async () => {
          throw new Error("unexpected core sendText");
        },
      },
    };
    setActivePluginRegistry(createTestRegistry([{ pluginId: "testchat", source: "test", plugin }]));
    await upsertSessionEntryCore(transcriptScope(), {
      sessionId: "main-session",
      updatedAt: 100,
      chatType: "direct",
      delivery: normalizeSessionDeliveryState({
        context: { channel: "discord", accountId: "default", to: "user:operator" },
        origin: { ...discordOrigin, accountId: "default" },
      }),
    });
  });

  afterEach(() => {
    setActivePluginRegistry(createTestRegistry([]));
  });

  it("leaves the main session route untouched when the send fails", async () => {
    handleAction.mockRejectedValue(
      new Error("testchat bot token missing. Set channels.testchat.botToken."),
    );

    await expect(send()).rejects.toThrow("token missing");

    expect(handleAction).toHaveBeenCalledOnce();
    expect(mainSessionOrigin()).toMatchObject(discordOrigin);
  });

  it("persists the outbound mirror route after a successful send", async () => {
    handleAction.mockResolvedValue(jsonResult({ ok: true, messageId: "m1" }));

    const result = await send();

    expect(result.kind).toBe("send");
    expect(mainSessionOrigin()).toMatchObject({ provider: "testchat", from: "testchat:12345" });
  });

  it.each(["plugin", "core"] as const)(
    "retains distinct media identities through %s sends with matching mirror text",
    async (handledBy) => {
      handleAction.mockResolvedValue(
        handledBy === "plugin" ? jsonResult({ ok: true, messageId: "media-send" }) : null,
      );
      sendMedia.mockResolvedValue({ channel: "testchat", messageId: "media-send" });
      const mediaUrls = ["https://example.com/one/chart.png", "https://example.com/two/chart.png"];
      for (const media of [...mediaUrls, mediaUrls[1]]) {
        const result = await send({ target: "user:12345", message: "Chart", media });
        expect(result.handledBy).toBe(handledBy);
      }
      const events = loadTranscriptEventsSync(transcriptScope());
      expect(events).toEqual([
        expect.objectContaining({ type: "session", id: "main-session" }),
        ...mediaUrls.map((mediaUrl) =>
          expect.objectContaining({
            type: "message",
            message: expect.objectContaining({
              content: [{ type: "text", text: "Chart\nchart.png" }],
              openclawDelivery: { mediaUrls: [mediaUrl] },
            }),
          }),
        ),
      ]);
      expect(handledBy === "plugin" ? handleAction : sendMedia).toHaveBeenCalledTimes(3);
    },
  );

  describe("Gateway-executed plugin sends", () => {
    const OTHER_SESSION_KEY = "agent:main:testchat:direct:12345";
    const gatewayRequest = vi.fn();
    const sendViaGateway = async (input: Partial<Parameters<typeof runMessageAction>[0]> = {}) => {
      let drained = Promise.resolve();
      const result = await runWithGatewayIndependentRootWorkAdmission(async () => {
        const observe = captureGatewayRootWorkReleaseObserver();
        if (!observe) {
          throw new Error("missing Gateway root admission");
        }
        drained = new Promise<void>((resolve) => {
          observe(() => resolve());
        });
        return runMessageAction({
          cfg,
          action: "send",
          params: { channel: "testchat", to: "user:12345", message: "card details" },
          agentId: "main",
          sessionKey: MAIN_SESSION_KEY,
          dryRun: false,
          gateway: {
            clientName: GATEWAY_CLIENT_NAMES.CLI,
            mode: GATEWAY_CLIENT_MODES.CLI,
            request: gatewayRequest,
          },
          ...input,
        });
      }, "gateway-mirror-test");
      return { result, drained };
    };
    const transcriptMessages = (sessionKey: string) => {
      const entry = loadExactSessionEntry({ ...transcriptScope(), sessionKey })?.entry;
      if (!entry?.sessionId) {
        return [];
      }
      return loadTranscriptEventsSync({
        ...transcriptScope(),
        sessionKey,
        sessionId: entry.sessionId,
      }).filter((event) => isCanonicalSessionTranscriptEntry(event) && event.type === "message");
    };

    beforeEach(() => {
      gatewayRequest.mockReset();
      gatewayRequest.mockResolvedValue({ ok: true, messageId: "gw-1" });
      executionMode = "gateway";
      cfg = { ...cfg, session: { ...cfg.session, dmScope: "per-channel-peer" } };
    });

    afterEach(() => {
      executionMode = "local";
    });

    it("mirrors a send after the destination turn, outside the source writer", async ({
      signal,
    }) => {
      const target = {
        ...transcriptScope(),
        sessionKey: OTHER_SESSION_KEY,
        sessionId: "destination",
      };
      await upsertSessionEntryCore(target, { sessionId: target.sessionId, updatedAt: 100 });
      const turnGate = createEnteredGate();
      const turn = withSessionTurn(target, turnGate.wait);
      let drained = Promise.resolve();
      try {
        await withinTest(turnGate.entered, signal);
        const sent = await withinTest(
          withSessionTranscriptWriteAssertion(
            transcriptScope(),
            () => {},
            () => sendViaGateway(),
          ),
          signal,
        );
        drained = sent.drained;
        expect(sent.result.handledBy).toBe("plugin");
        expect(gatewayRequest).toHaveBeenCalledOnce();
        expect(handleAction).not.toHaveBeenCalled();
        expect(transcriptMessages(OTHER_SESSION_KEY)).toEqual([]);
        turnGate.release();
        await withinTest(turn, signal);
        await withinTest(drained, signal);
        expect(transcriptMessages(OTHER_SESSION_KEY)).toEqual([
          expect.objectContaining({
            message: expect.objectContaining({ content: [{ type: "text", text: "card details" }] }),
          }),
        ]);
        expect(transcriptMessages(MAIN_SESSION_KEY)).toEqual([]);
      } finally {
        turnGate.release();
        await Promise.allSettled([turn, drained]);
      }
    });

    it.each([
      { name: "current source", input: { sessionKey: OTHER_SESSION_KEY } },
      { name: "source-reply override", input: { sourceReplySessionKey: OTHER_SESSION_KEY } },
      { name: "suppressed mirror", input: { suppressTranscriptMirror: true } },
      { name: "suppressed send", receipt: { status: "suppressed" } },
      { name: "failed send", receipt: { ok: false, error: "send failed", messageId: "attempt" } },
      { name: "dry-run receipt", receipt: { dryRun: true, messageId: "preview" } },
      {
        name: "partial delivery",
        receipt: { deliveryStatus: "partial_failed", sentBeforeError: true, messageId: "partial" },
      },
    ])("does not add a destination mirror for $name", async ({ input, receipt }) => {
      if (receipt) {
        gatewayRequest.mockResolvedValueOnce(receipt);
      }
      const { drained } = await sendViaGateway(input);
      await drained;
      expect(gatewayRequest).toHaveBeenCalledOnce();
      expect(transcriptMessages(OTHER_SESSION_KEY)).toEqual([]);
    });
  });

  it.each([
    ["suppresses delivery", { status: "suppressed", reason: "cancelled_by_message_sending_hook" }],
    ["fails with an attempt ID", { ok: false, error: "send failed", messageId: "attempt-id" }],
    ["returns a dry-run receipt", { dryRun: true, messageId: "preview-id" }],
  ] as const)(
    "leaves the stored route and transcript untouched when a plugin %s",
    async (_name, payload) => {
      const transcriptBefore = loadTranscriptEventsSync(transcriptScope());
      handleAction.mockResolvedValue(jsonResult(payload));
      const result = await send({ to: "user:12345", message: "omitted" });
      expect(result.payload).toEqual(payload);
      expect.soft(mainSessionOrigin()).toMatchObject(discordOrigin);
      expect(loadTranscriptEventsSync(transcriptScope())).toEqual(transcriptBefore);
    },
  );
});
