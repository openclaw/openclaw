import path from "node:path";
// Regression: outbound route persistence must commit only after a
// successful send. A failed probe (missing channel credentials) previously
// rewrote the folded main session's durable delivery route and minted a
// conversation identity before the send was attempted.
import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { jsonResult } from "../../agents/tools/common.js";
import type { ChannelPlugin } from "../../channels/plugins/types.public.js";
import type { OpenClawConfig } from "../../config/config.js";
import {
  loadExactSessionEntry,
  loadTranscriptEventsSync,
  upsertSessionEntryCore,
} from "../../config/sessions/session-accessor.js";
import { setActivePluginRegistry } from "../../plugins/runtime.js";
import {
  createChannelTestPluginBase,
  createTestRegistry,
} from "../../test-utils/channel-plugins.js";
import { useSessionStoreTempDirs } from "../../test-utils/session-state-cleanup.js";
import { sessionDeliveryOrigin } from "../../utils/delivery-context.read.js";
import { normalizeSessionDeliveryState } from "../../utils/delivery-context.shared.js";
import { runMessageAction } from "./message-action-runner.js";

vi.mock("../../tts/tts.runtime.js", () => ({
  maybeApplyTtsToPayload: vi.fn(async (params: { payload: unknown }) => params.payload),
}));

const MAIN_SESSION_KEY = "agent:main:main";

describe("confirmed outbound route and transcript ownership", () => {
  const sessionDirs = useSessionStoreTempDirs(afterAll, "openclaw-mirror-order-");
  let storePath: string;
  let cfg: OpenClawConfig;
  const handleAction = vi.fn();

  function registerTestChannel() {
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
        handleAction,
      },
      outbound: {
        deliveryMode: "direct",
        // The plugin action path above owns the send; core delivery must not run.
        sendText: async () => {
          throw new Error("unexpected core sendText");
        },
      },
    };
    setActivePluginRegistry(createTestRegistry([{ pluginId: "testchat", source: "test", plugin }]));
  }

  async function seedMainSessionWithDiscordOrigin() {
    await upsertSessionEntryCore(
      { agentId: "main", sessionKey: MAIN_SESSION_KEY, storePath },
      {
        sessionId: "main-session",
        updatedAt: 100,
        chatType: "direct",
        delivery: normalizeSessionDeliveryState({
          context: { channel: "discord", accountId: "default", to: "user:operator" },
          origin: { provider: "discord", accountId: "default", from: "discord:operator" },
        }),
      },
    );
  }

  function mainSessionOrigin() {
    const persisted = loadExactSessionEntry({
      agentId: "main",
      sessionKey: MAIN_SESSION_KEY,
      storePath,
    });
    return sessionDeliveryOrigin(persisted?.entry);
  }

  beforeEach(async () => {
    storePath = path.join(sessionDirs.make(), "sessions.json");
    cfg = {
      session: { store: storePath },
      channels: { testchat: { enabled: true } },
    } as OpenClawConfig;
    handleAction.mockReset();
    registerTestChannel();
    await seedMainSessionWithDiscordOrigin();
  });

  afterEach(() => {
    setActivePluginRegistry(createTestRegistry([]));
  });

  it("leaves the main session route untouched when the send fails", async () => {
    handleAction.mockRejectedValue(
      new Error("testchat bot token missing. Set channels.testchat.botToken."),
    );

    await expect(
      runMessageAction({
        cfg,
        action: "send",
        params: { channel: "testchat", to: "user:12345", message: "hi" },
        agentId: "main",
        dryRun: false,
      }),
    ).rejects.toThrow("token missing");

    expect(handleAction).toHaveBeenCalledOnce();
    expect(mainSessionOrigin()).toMatchObject({
      provider: "discord",
      from: "discord:operator",
    });
  });

  it("persists the outbound route after a successful send", async () => {
    handleAction.mockResolvedValue(jsonResult({ ok: true, messageId: "m1" }));

    const result = await runMessageAction({
      cfg,
      action: "send",
      params: { channel: "testchat", to: "user:12345", message: "hi" },
      agentId: "main",
      dryRun: false,
    });

    expect(result.kind).toBe("send");
    expect(mainSessionOrigin()).toMatchObject({
      provider: "testchat",
      from: "testchat:12345",
    });
  });

  it("writes a cross-chat message-tool send once to the destination, not the producer", async () => {
    cfg.session = { ...cfg.session, dmScope: "per-channel-peer" };
    handleAction.mockResolvedValue(jsonResult({ ok: true, messageId: "m1" }));
    const sourceScope = {
      agentId: "main",
      sessionKey: MAIN_SESSION_KEY,
      sessionId: "main-session",
      storePath,
    };
    const sourceBefore = loadTranscriptEventsSync(sourceScope);
    const input = {
      cfg,
      action: "send" as const,
      actionOrigin: "message-tool" as const,
      params: {
        channel: "testchat",
        to: "user:12345",
        message: "visible destination text",
        idempotencyKey: "stable-message-tool-send",
      },
      sessionKey: MAIN_SESSION_KEY,
      agentId: "main",
      dryRun: false,
    };
    await runMessageAction(input);
    await runMessageAction({ ...input, params: { ...input.params } });

    const destinationKey = "agent:main:testchat:direct:12345";
    const destination = loadExactSessionEntry({
      agentId: "main",
      sessionKey: destinationKey,
      storePath,
    });
    expect(destination).not.toBeNull();
    const messages = loadTranscriptEventsSync({
      agentId: "main",
      sessionKey: destinationKey,
      sessionId: destination!.entry.sessionId,
      storePath,
    }).filter((event) => asOptionalRecord(event)?.type === "message");
    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatchObject({
      message: {
        role: "assistant",
        provider: "openclaw",
        model: "automation-result",
        content: [{ type: "text", text: "visible destination text" }],
      },
    });
    expect(loadTranscriptEventsSync(sourceScope)).toEqual(sourceBefore);
  });

  it("does not append a second assistant row for a same-chat message-tool send", async () => {
    handleAction.mockResolvedValue(jsonResult({ ok: true, messageId: "same-chat" }));
    const scope = {
      agentId: "main",
      sessionKey: MAIN_SESSION_KEY,
      sessionId: "main-session",
      storePath,
    };
    const before = loadTranscriptEventsSync(scope);
    await runMessageAction({
      cfg,
      action: "send",
      actionOrigin: "message-tool",
      params: { channel: "testchat", to: "user:12345", message: "same chat" },
      sessionKey: MAIN_SESSION_KEY,
      agentId: "main",
      dryRun: false,
    });
    expect(loadTranscriptEventsSync(scope)).toEqual(before);
  });

  it.each([
    {
      name: "suppresses delivery",
      payload: { status: "suppressed", reason: "cancelled_by_message_sending_hook" },
    },
    {
      name: "fails with an attempt ID",
      payload: { ok: false, error: "send failed", messageId: "attempt-id" },
    },
    {
      name: "returns a dry-run receipt",
      payload: { dryRun: true, messageId: "preview-id" },
    },
  ])(
    "leaves the stored route and transcript untouched when a plugin $name",
    async ({ payload }) => {
      const transcriptScope = {
        agentId: "main",
        sessionKey: MAIN_SESSION_KEY,
        sessionId: "main-session",
        storePath,
      };
      const transcriptBefore = loadTranscriptEventsSync(transcriptScope);
      handleAction.mockResolvedValue(jsonResult(payload));
      const result = await runMessageAction({
        cfg,
        action: "send",
        params: { channel: "testchat", to: "user:12345", message: "omitted" },
        agentId: "main",
        dryRun: false,
      });
      expect(result.payload).toEqual(payload);
      expect.soft(mainSessionOrigin()).toMatchObject({
        provider: "discord",
        from: "discord:operator",
      });
      expect(loadTranscriptEventsSync(transcriptScope)).toEqual(transcriptBefore);
    },
  );
});
