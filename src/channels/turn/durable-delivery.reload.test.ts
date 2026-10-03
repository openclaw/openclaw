import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { persistPendingFinalDeliveryMarker } from "../../agents/pending-final-delivery-marker.js";
import { clearPendingFinalDeliveryAfterSuccess } from "../../auto-reply/reply/dispatch-from-config.pending-final.js";
import { resolvePendingFinalDeliveryCompletion } from "../../auto-reply/reply/pending-final-delivery.js";
import { loadSessionEntry, replaceSessionEntry } from "../../config/sessions/session-accessor.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type { TelegramAccountConfig } from "../../config/types.telegram.js";
import {
  installDeliveryQueueTmpDirHooks,
  loadPendingDeliveries,
} from "../../infra/outbound/delivery-queue.test-helpers.js";
import { createStructuredOutboundPayloadPlan } from "../../infra/outbound/payloads.js";
import { PluginInstance } from "../../plugins/plugin-instance.js";
import { bindPluginRegistryGatewayOwner } from "../../plugins/registry-lifecycle.js";
import {
  createPluginRegistryOwner,
  getActivePluginRegistry,
  resetPluginRuntimeStateForTest,
  setActivePluginRegistry,
} from "../../plugins/runtime.js";
import { withPluginRuntimeRegistryScope } from "../../plugins/runtime/gateway-request-scope.js";
import { setPluginRuntimeLoadContext } from "../../plugins/runtime/load-context.js";
import { loadBundledPluginFacade } from "../../test-utils/bundled-plugin-public-surface.js";
import {
  createChannelTestPluginBase,
  createTestRegistry,
} from "../../test-utils/channel-plugins.js";
import type { ChannelMessageSendTextContext } from "../message/types.js";
import {
  deliverInboundReplyWithMessageSendContextCore,
  deliverStructuredInboundReplyWithMessageSendContextCore,
  type DurableInboundReplyDeliveryParams,
} from "./durable-delivery.js";

const cfg: OpenClawConfig = { channels: { telegram: { enabled: true } } };

async function replacementFixture(options?: { newChannel?: boolean; sameGeneration?: boolean }) {
  const retired = new PluginInstance("discord");
  const old = createTestRegistry([
    {
      pluginId: "discord",
      source: "test",
      plugin: retired.wrap({
        ...createChannelTestPluginBase({ id: "discord" }),
        get id() {
          return "discord";
        },
      }),
    },
  ]);
  const sendText = vi.fn(async (_ctx: ChannelMessageSendTextContext) => ({
    messageId: "accepted-final",
  }));
  const beforeSendAttempt = vi.fn(async () => {});
  const current = createTestRegistry([
    {
      pluginId: "telegram",
      source: "test",
      plugin: {
        ...createChannelTestPluginBase({ id: "telegram" }),
        message: {
          id: "telegram",
          durableFinal: { capabilities: { text: true, messageSendingHooks: true } },
          send: { text: sendText, lifecycle: { beforeSendAttempt } },
        },
      },
    },
  ]);
  if (!options?.newChannel) {
    old.channels.push(...current.channels);
  }
  const setConfig = (config: OpenClawConfig) =>
    setPluginRuntimeLoadContext(current, {
      rawConfig: config,
      config,
      activationSourceConfig: config,
      autoEnabledReasons: {},
      workspaceDir: undefined,
      env: {},
      logger: { info() {}, warn() {}, error() {}, debug() {} },
    });
  setConfig(cfg);
  const publication: { current: typeof current | undefined } = { current };
  const owner = { current: () => publication.current };
  bindPluginRegistryGatewayOwner(old, owner);
  bindPluginRegistryGatewayOwner(current, owner);
  // Agent-only registries inherit ingress identity even when they expose no channels.
  const turn = createTestRegistry([]);
  bindPluginRegistryGatewayOwner(turn, owner, options?.sameGeneration ? current : old);
  // A different process-root Gateway must never become the delivery owner.
  setActivePluginRegistry(createTestRegistry([]));
  await retired.dispose();
  const request: DurableInboundReplyDeliveryParams = {
    cfg,
    channel: "telegram",
    accountId: "default",
    agentId: "main",
    payload: { text: "Saved final answer" },
    info: { kind: "final" },
    ctxPayload: {
      CommandAuthorized: true,
      CommandTurn: { kind: "normal", source: "message", authorized: false },
      OriginatingTo: "12345",
    },
  };
  const deliver = (structured = false, scope = turn) =>
    withPluginRuntimeRegistryScope(scope, () => {
      if (!structured) {
        return deliverInboundReplyWithMessageSendContextCore(request);
      }
      const [plan] = createStructuredOutboundPayloadPlan([request.payload]);
      if (!plan) {
        throw new Error("Expected a sendable final reply");
      }
      return deliverStructuredInboundReplyWithMessageSendContextCore({ ...request, plan });
    });
  return {
    old,
    turn,
    current,
    publication,
    setConfig,
    sendText,
    beforeSendAttempt,
    deliver,
    request,
  };
}

describe("final delivery after plugin replacement", () => {
  const state = installDeliveryQueueTmpDirHooks();
  afterEach(() => {
    resetPluginRuntimeStateForTest();
    vi.unstubAllEnvs();
  });

  it.each([
    { sameGeneration: true, structured: false },
    { sameGeneration: false, structured: true },
  ])(
    "settles final custody through its Gateway without sender preparation (sameGeneration=$sameGeneration, structured=$structured)",
    async ({ sameGeneration, structured }) => {
      vi.stubEnv("OPENCLAW_STATE_DIR", state.tmpDir());
      const fixture = await replacementFixture({ sameGeneration });
      const successorConfig: OpenClawConfig = { ...cfg, logging: { level: "debug" } };
      fixture.setConfig(successorConfig);
      const locator = {
        agentId: "main",
        sessionKey: "agent:main:telegram:direct:12345",
        storePath: path.join(state.tmpDir(), "sessions.json"),
      };
      const entry = { sessionId: "ordinary-final-session", updatedAt: 1 };
      await replaceSessionEntry(locator, entry);
      await persistPendingFinalDeliveryMarker({
        ...locator,
        deliver: true,
        sessionEntry: entry,
        sessionStore: { [locator.sessionKey]: entry },
        suppressVisibleSessionEffects: false,
        sessionReboundDuringRun: false,
        payloads: [fixture.request.payload],
        deliveryContext: { channel: "telegram", to: "12345" },
        runOwnedSessionId: entry.sessionId,
      });
      const completion = resolvePendingFinalDeliveryCompletion([fixture.request.payload]);
      if (!completion) {
        throw new Error("Expected production-owned pending-final custody");
      }
      expect(loadSessionEntry(locator)?.pendingFinalDelivery?.deliveries).toEqual([
        { id: completion.deliveryId, state: "prepared" },
      ]);
      const result = await fixture.deliver(structured);
      if (result.status === "failed") {
        throw result.error;
      }
      expect(result).toMatchObject({
        status: "handled_visible",
        delivery: {
          visibleReplySent: true,
          messageIds: ["accepted-final"],
          receipt: { platformMessageIds: ["accepted-final"] },
        },
      });
      expect(fixture.sendText).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({
          cfg: sameGeneration ? cfg : successorConfig,
          to: "12345",
          text: "Saved final answer",
          accountId: "default",
        }),
      );
      expect(loadSessionEntry(locator)?.pendingFinalDelivery?.deliveries).toEqual([
        { id: completion.deliveryId, state: "delivered" },
      ]);
      expect(await loadPendingDeliveries(state.tmpDir())).toEqual([]);
      await clearPendingFinalDeliveryAfterSuccess(completion);
      expect(loadSessionEntry(locator)?.pendingFinalDelivery).toBeUndefined();
    },
  );

  it.each([
    "closed",
    "removed",
    "account-changed",
    "defaults-changed",
    "plugin-changed",
    "plugin-id-changed",
    "new-channel",
    "replaced-channel",
    "superseded-before-send",
    "superseded-live-send",
    "superseded-prepared-send",
  ] as const)("does not send or borrow the process root when %s", async (stateChange) => {
    vi.stubEnv("OPENCLAW_STATE_DIR", state.tmpDir());
    const fixture = await replacementFixture({
      newChannel: stateChange === "new-channel",
      sameGeneration: stateChange === "superseded-prepared-send",
    });
    setActivePluginRegistry(createTestRegistry([...fixture.current.channels]));
    if (stateChange === "replaced-channel") {
      fixture.current.channels = fixture.current.channels.map((entry) => ({
        ...entry,
        plugin: { ...entry.plugin },
      }));
    }
    if (stateChange === "plugin-id-changed") {
      fixture.current.channels = fixture.current.channels.map((entry) => ({
        ...entry,
        pluginId: "another-owner",
      }));
    }
    if (stateChange === "closed") {
      fixture.publication.current = undefined;
    }
    if (stateChange === "removed") {
      fixture.current.channels = [];
    }
    if (stateChange === "account-changed") {
      fixture.setConfig({ channels: { telegram: { enabled: false } } });
    }
    if (stateChange === "defaults-changed") {
      fixture.setConfig({ channels: { ...cfg.channels, defaults: { groupPolicy: "disabled" } } });
    }
    if (stateChange === "plugin-changed") {
      fixture.setConfig({ ...cfg, plugins: { entries: { telegram: { enabled: false } } } });
    }
    if (stateChange.startsWith("superseded")) {
      fixture.beforeSendAttempt.mockImplementation(async () => {
        fixture.publication.current = undefined;
      });
    }
    const result = await fixture.deliver(
      false,
      stateChange === "superseded-live-send" ? fixture.current : fixture.turn,
    );
    expect(result).toMatchObject({
      status: "failed",
      error: {
        message: expect.stringContaining(
          stateChange === "closed"
            ? "closing"
            : stateChange.startsWith("superseded")
              ? "runtime changed"
              : "channel changed",
        ),
      },
    });
    expect(fixture.sendText).not.toHaveBeenCalled();
  });
});

type TelegramDispatchHttpFixture = {
  token: string;
  state: { path: (name: string) => string };
  calls: Array<{ method: string; fields: Record<string, unknown> }>;
  endpoints: string[];
  visibleMessages: Map<number, string>;
  dispatchProgressTurn: (
    emitEvents: () => Promise<void>,
    scenario: {
      mode: "off";
      toolProgress: boolean;
      finalReply: { text: string };
      allowErrors: boolean;
      telegramCfg: TelegramAccountConfig;
      cfg: OpenClawConfig;
      onDispatch: (config: OpenClawConfig) => void;
    },
  ) => Promise<unknown>;
};

const { createTelegramDispatchHttpFixture } = await loadBundledPluginFacade<{
  createTelegramDispatchHttpFixture: () => TelegramDispatchHttpFixture;
}>({ pluginId: "telegram", artifactBasename: "dispatch.test-api.js" });

const finalText = "Saved final answer after an unrelated reload.";
const replacementToken = "654321:reload-test-replacement";

describe("Telegram final sender after registry replacement", () => {
  const http = createTelegramDispatchHttpFixture();
  afterEach(() => vi.unstubAllEnvs());

  it.each(["unchanged", "environment", "token-file", "secret-ref"] as const)(
    "keeps the admitted bot when credentials are %s",
    async (source) => {
      const old = getActivePluginRegistry();
      if (!old) {
        throw new Error("Expected the fixture's Telegram registry");
      }
      const owner = createPluginRegistryOwner(old);
      const next = createTestRegistry([...old.channels]);
      const tokenFile = http.state.path("telegram-token");
      if (source === "token-file") {
        await fs.writeFile(tokenFile, http.token, { mode: 0o600 });
      }
      vi.stubEnv("TELEGRAM_BOT_TOKEN", http.token);
      vi.stubEnv("TELEGRAM_TEST_RELOAD_TOKEN", http.token);
      try {
        await withPluginRuntimeRegistryScope(old, () =>
          http.dispatchProgressTurn(
            async () => {
              if (source === "environment") {
                vi.stubEnv("TELEGRAM_BOT_TOKEN", replacementToken);
              } else if (source === "token-file") {
                await fs.writeFile(tokenFile, replacementToken, { mode: 0o600 });
              } else if (source === "secret-ref") {
                vi.stubEnv("TELEGRAM_TEST_RELOAD_TOKEN", replacementToken);
              }
              setActivePluginRegistry(next);
              owner.publish(next);
              // Another Gateway's process projection is never our delivery owner.
              setActivePluginRegistry(createTestRegistry([]));
            },
            {
              mode: "off",
              toolProgress: false,
              finalReply: { text: finalText },
              allowErrors: source !== "unchanged",
              telegramCfg:
                source === "token-file"
                  ? { botToken: undefined, tokenFile }
                  : source === "environment"
                    ? { botToken: undefined }
                    : source === "secret-ref"
                      ? {
                          botToken: {
                            source: "env",
                            provider: "reload",
                            id: "TELEGRAM_TEST_RELOAD_TOKEN",
                          },
                        }
                      : {},
              cfg: {
                secrets: {
                  providers: {
                    reload: { source: "env", allowlist: ["TELEGRAM_TEST_RELOAD_TOKEN"] },
                  },
                },
              },
              onDispatch(dispatchConfig) {
                for (const registry of [old, next]) {
                  setPluginRuntimeLoadContext(registry, {
                    rawConfig: dispatchConfig,
                    config: dispatchConfig,
                    activationSourceConfig: dispatchConfig,
                    autoEnabledReasons: {},
                    workspaceDir: undefined,
                    env: {},
                    logger: { info() {}, warn() {}, error() {}, debug() {} },
                  });
                }
              },
            },
          ),
        );
        const finals = http.calls.filter(
          (call) => call.method === "sendMessage" && call.fields.text === finalText,
        );
        if (source === "unchanged") {
          expect(finals).toHaveLength(1);
          expect(http.endpoints[http.calls.findIndex((call) => call === finals[0])]).toBe(
            "/bot" + http.token + "/sendMessage",
          );
          expect([...http.visibleMessages.values()]).toContain(finalText);
        } else {
          expect(finals).toEqual([]);
          expect([...http.visibleMessages.values()]).not.toContain(finalText);
        }
        expect(http.endpoints.some((endpoint) => endpoint.includes(replacementToken))).toBe(false);
      } finally {
        await owner.close();
      }
    },
  );
});
