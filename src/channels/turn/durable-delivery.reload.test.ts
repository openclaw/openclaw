import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { awaitGateBeforeSettlement, createDeferred } from "../../../test/helpers/promise.js";
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
import type * as SleepModule from "../../utils/sleep.js";
import { sleep } from "../../utils/sleep.js";
import { sendDurableMessageBatchCore } from "../message/send.js";
import type { ChannelMessageSendTextContext } from "../message/types.js";
import {
  deliverInboundReplyWithMessageSendContextCore,
  deliverStructuredInboundReplyWithMessageSendContextCore,
  type DurableInboundReplyDeliveryParams,
} from "./durable-delivery.js";

vi.mock("../../utils/sleep.js", async (importOriginal) => ({
  ...(await importOriginal<typeof SleepModule>()),
  sleep: vi.fn(async () => {}),
}));

const cfg: OpenClawConfig = { channels: { telegram: { enabled: true } } };

async function replacementFixture(options?: {
  newChannel?: boolean;
  sameGeneration?: boolean;
  missingAdmissionConfig?: boolean;
}) {
  const retired = new PluginInstance("discord");
  const old = createTestRegistry(
    [
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
    ],
    options?.missingAdmissionConfig ? undefined : { config: cfg },
  );
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
          durableFinal: {
            capabilities: { text: true, media: true, payload: true, messageSendingHooks: true },
          },
          send: {
            text: sendText,
            media: sendText,
            payload: sendText,
            lifecycle: { beforeSendAttempt },
          },
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
    retryAmbiguousFinalText: true,
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

  it("keeps the final caller pending until saved rich text is recovered", async () => {
    vi.stubEnv("OPENCLAW_STATE_DIR", state.tmpDir());
    const fixture = await replacementFixture({ sameGeneration: true });
    fixture.request.payload = { text: "**Saved final** with [a link](https://example.com)" };
    const retryStarted = createDeferred();
    const retryResult = createDeferred<{ messageId: string }>();
    fixture.sendText
      .mockRejectedValueOnce(
        new Error("network request failed", {
          cause: Object.assign(new Error("socket reset"), { code: "ECONNRESET" }),
        }),
      )
      .mockImplementationOnce(async () => {
        retryStarted.resolve();
        return await retryResult.promise;
      });
    let settled = false;
    const delivery = fixture.deliver(true).then((result) => {
      settled = true;
      return result;
    });
    try {
      await awaitGateBeforeSettlement(
        retryStarted.promise,
        delivery,
        "The final caller settled before automatic recovery",
      );
      expect(await loadPendingDeliveries(state.tmpDir())).toMatchObject([
        { maxRetries: 2, attemptCount: 2 },
      ]);
      expect(settled).toBe(false);
      expect(fixture.sendText).toHaveBeenCalledTimes(2);
      expect(fixture.sendText.mock.calls.map(([ctx]) => ctx.text)).toEqual([
        fixture.request.payload.text,
        fixture.request.payload.text,
      ]);
    } finally {
      retryResult.resolve({ messageId: "recovered-final" });
    }
    await expect(delivery).resolves.toMatchObject({
      status: "handled_visible",
      delivery: { messageIds: ["recovered-final"] },
    });
    expect(await loadPendingDeliveries(state.tmpDir())).toEqual([]);
  });

  it("reports the second failure after its one automatic retry is exhausted", async () => {
    vi.stubEnv("OPENCLAW_STATE_DIR", state.tmpDir());
    const fixture = await replacementFixture({ sameGeneration: true });
    fixture.sendText
      .mockRejectedValueOnce(Object.assign(new Error("socket reset"), { code: "ECONNRESET" }))
      .mockRejectedValueOnce(new Error("Telegram rejected the saved final"));
    await expect(fixture.deliver()).resolves.toMatchObject({
      status: "failed",
      error: { message: "Telegram rejected the saved final", queueCustody: "released" },
    });
    expect(fixture.sendText).toHaveBeenCalledTimes(2);
    expect(await loadPendingDeliveries(state.tmpDir())).toEqual([]);
  });

  it("retains the accepted chunk when the final retry fails without replaying it", async () => {
    vi.stubEnv("OPENCLAW_STATE_DIR", state.tmpDir());
    const fixture = await replacementFixture({ sameGeneration: true });
    fixture.sendText
      .mockRejectedValueOnce(Object.assign(new Error("socket reset"), { code: "ECONNRESET" }))
      .mockImplementationOnce(async (ctx) => {
        await ctx.onDeliveryResult?.({
          messageId: "accepted-retry-chunk",
          receipt: {
            primaryPlatformMessageId: "accepted-retry-chunk",
            platformMessageIds: ["accepted-retry-chunk"],
            parts: [{ platformMessageId: "accepted-retry-chunk", kind: "text", index: 0 }],
            sentAt: 1,
          },
        });
        throw new Error("second retry chunk rejected");
      });
    await expect(fixture.deliver()).resolves.toMatchObject({
      status: "failed",
      sentBeforeError: true,
      error: {
        message: "second retry chunk rejected",
        deliveryResult: { visibleReplySent: true, messageIds: ["accepted-retry-chunk"] },
        cause: {
          results: [expect.objectContaining({ messageId: "accepted-retry-chunk" })],
          payloadOutcomes: [expect.objectContaining({ status: "failed", sentBeforeError: true })],
        },
      },
    });
    expect(fixture.sendText).toHaveBeenCalledTimes(2);
    expect(await loadPendingDeliveries(state.tmpDir())).toEqual([]);
  });

  it.each(["backoff", "preparation"] as const)(
    "blocks the retry when its runtime is superseded during %s",
    async (phase) => {
      vi.stubEnv("OPENCLAW_STATE_DIR", state.tmpDir());
      const fixture = await replacementFixture({ sameGeneration: true });
      fixture.sendText.mockRejectedValueOnce(
        Object.assign(new Error("socket reset"), { code: "ECONNRESET" }),
      );
      const supersede = async () => {
        fixture.publication.current = undefined;
      };
      if (phase === "backoff") {
        vi.mocked(sleep).mockImplementationOnce(supersede);
      } else {
        fixture.beforeSendAttempt
          .mockImplementationOnce(async () => {})
          .mockImplementationOnce(supersede);
      }
      await expect(fixture.deliver()).resolves.toMatchObject({
        status: "failed",
        error: { message: expect.stringContaining("runtime changed") },
      });
      expect(fixture.sendText).toHaveBeenCalledTimes(1);
      expect(await loadPendingDeliveries(state.tmpDir())).toEqual([]);
    },
  );

  it.each([
    { text: "A photo", mediaUrl: "https://example.com/photo.png" },
    { text: "Pinned reply", delivery: { pin: true } },
    { text: "Choose", channelData: { buttons: [["yes"]] } },
  ])("does not replay side-effect or media finals: $text", async (payload) => {
    vi.stubEnv("OPENCLAW_STATE_DIR", state.tmpDir());
    const fixture = await replacementFixture({ sameGeneration: true });
    fixture.request.payload = payload;
    fixture.sendText.mockRejectedValue(
      Object.assign(new Error("socket reset"), { code: "ECONNRESET" }),
    );
    await expect(fixture.deliver()).resolves.toMatchObject({ status: "failed" });
    expect(fixture.sendText).toHaveBeenCalledTimes(1);
  });

  it("does not replay a final with an already accepted chunk", async () => {
    vi.stubEnv("OPENCLAW_STATE_DIR", state.tmpDir());
    const fixture = await replacementFixture({ sameGeneration: true });
    fixture.sendText.mockRejectedValue(
      Object.assign(new Error("later chunk failed"), {
        cause: Object.assign(new Error("socket reset"), { code: "ECONNRESET" }),
        deliveryResult: { visibleReplySent: true, messageIds: ["accepted-chunk"] },
      }),
    );
    await expect(fixture.deliver()).resolves.toMatchObject({ status: "failed" });
    expect(fixture.sendText).toHaveBeenCalledTimes(1);
  });

  it("does not infer transport ambiguity from an error message", async () => {
    vi.stubEnv("OPENCLAW_STATE_DIR", state.tmpDir());
    const fixture = await replacementFixture({ sameGeneration: true });
    fixture.sendText.mockRejectedValue(new Error("Network request failed for sendMessage"));
    await expect(fixture.deliver()).resolves.toMatchObject({ status: "failed" });
    expect(fixture.sendText).toHaveBeenCalledTimes(1);
  });

  it("does not replay when the channel has not opted in", async () => {
    vi.stubEnv("OPENCLAW_STATE_DIR", state.tmpDir());
    const fixture = await replacementFixture({ sameGeneration: true });
    fixture.request.retryAmbiguousFinalText = undefined;
    fixture.sendText.mockRejectedValue(
      Object.assign(new Error("socket reset"), { code: "ECONNRESET" }),
    );
    await expect(fixture.deliver()).resolves.toMatchObject({ status: "failed" });
    expect(fixture.sendText).toHaveBeenCalledTimes(1);
  });

  it.each([
    { sameGeneration: true, structured: false, retry: false, tool: false },
    { sameGeneration: false, structured: true, retry: false, tool: false },
    { sameGeneration: true, structured: false, retry: true, tool: false },
    { sameGeneration: true, structured: false, retry: true, tool: true },
  ])(
    "preserves final custody (sameGeneration=$sameGeneration, structured=$structured, retry=$retry, tool=$tool)",
    async ({ sameGeneration, structured, retry, tool }) => {
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
      if (retry) {
        fixture.sendText.mockRejectedValueOnce(
          Object.assign(new Error("socket reset"), { code: "ECONNRESET" }),
        );
      }
      if (tool) {
        const result = await withPluginRuntimeRegistryScope(fixture.current, () =>
          sendDurableMessageBatchCore({
            cfg,
            channel: "telegram",
            accountId: "default",
            to: "12345",
            payloads: [fixture.request.payload],
          }),
        );
        expect(result.status).toBe("failed");
        expect(fixture.sendText).toHaveBeenCalledTimes(1);
        expect(
          (await loadPendingDeliveries(state.tmpDir()))[0]?.retryAmbiguousFinalText,
        ).toBeUndefined();
        return;
      }
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
      expect(fixture.sendText).toHaveBeenCalledTimes(retry ? 2 : 1);
      expect(fixture.sendText).toHaveBeenLastCalledWith(
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
    "missing-admission-config",
    "superseded-before-send",
    "superseded-live-send",
    "superseded-prepared-send",
  ] as const)("does not send or borrow the process root when %s", async (stateChange) => {
    vi.stubEnv("OPENCLAW_STATE_DIR", state.tmpDir());
    const fixture = await replacementFixture({
      newChannel: stateChange === "new-channel",
      sameGeneration: stateChange === "superseded-prepared-send",
      missingAdmissionConfig: stateChange === "missing-admission-config",
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

  it("uses publication settings through prepared views and current policy for delivery", async () => {
    vi.stubEnv("OPENCLAW_STATE_DIR", state.tmpDir());
    const fixture = await replacementFixture();
    fixture.request.cfg = {
      ...cfg,
      channels: { telegram: { ...cfg.channels?.telegram, responsePrefix: "[ACCOUNT]" } },
    };
    const currentConfig: OpenClawConfig = {
      ...cfg,
      tools: { fs: { workspaceOnly: true } },
    };
    fixture.setConfig(currentConfig);
    setPluginRuntimeLoadContext(fixture.turn, {
      rawConfig: fixture.request.cfg,
      config: fixture.request.cfg,
      activationSourceConfig: fixture.request.cfg,
      autoEnabledReasons: {},
      workspaceDir: undefined,
      env: {},
      logger: { info() {}, warn() {}, error() {}, debug() {} },
    });
    fixture.request.prepareRuntimeHandoff = (current) => ({
      ...current,
      channels: { telegram: { ...current.channels?.telegram, responsePrefix: "[ACCOUNT]" } },
    });
    await expect(fixture.deliver()).resolves.toMatchObject({ status: "handled_visible" });
    expect(fixture.sendText).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        cfg: {
          channels: { telegram: { enabled: true, responsePrefix: "[ACCOUNT]" } },
          tools: { fs: { workspaceOnly: true } },
        },
      }),
    );
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
      let owner: ReturnType<typeof createPluginRegistryOwner> | undefined;
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
              if (!owner) {
                throw new Error("Expected publication after preparing the dispatch config");
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
                owner = createPluginRegistryOwner(old);
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
        await owner?.close();
      }
    },
  );
});
