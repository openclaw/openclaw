import fs from "node:fs/promises";
import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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
const connectionReset = () => Object.assign(new Error("socket reset"), { code: "ECONNRESET" });

function setConfig(
  registry: Parameters<typeof setPluginRuntimeLoadContext>[0],
  config: OpenClawConfig,
) {
  setPluginRuntimeLoadContext(registry, {
    rawConfig: config,
    config,
    activationSourceConfig: config,
    autoEnabledReasons: {},
    workspaceDir: undefined,
    env: {},
    logger: { info() {}, warn() {}, error() {}, debug() {} },
  });
}

async function replacementFixture(options?: {
  newChannel?: boolean;
  sameGeneration?: boolean;
  missingAdmissionConfig?: boolean;
}) {
  const retired = new PluginInstance("discord");
  const registryFor = (pluginId: string, plugin: unknown, config?: OpenClawConfig) =>
    createTestRegistry([{ pluginId, source: "test", plugin }], config ? { config } : undefined);
  const old = registryFor(
    "discord",
    retired.wrap({
      ...createChannelTestPluginBase({ id: "discord" }),
      get id() {
        return "discord";
      },
    }),
    options?.missingAdmissionConfig ? undefined : cfg,
  );
  const sendText = vi.fn(async (_ctx: ChannelMessageSendTextContext) => ({
    messageId: "accepted-final",
  }));
  const beforeSendAttempt = vi.fn(async () => {});
  const current = registryFor("telegram", {
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
  });
  if (!options?.newChannel) {
    old.channels.push(...current.channels);
  }
  setConfig(current, cfg);
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
      const plan = expectDefined(
        createStructuredOutboundPayloadPlan([request.payload])[0],
        "final plan",
      );
      return deliverStructuredInboundReplyWithMessageSendContextCore({ ...request, plan });
    });
  return {
    turn,
    current,
    publication,
    setConfig: (config: OpenClawConfig) => setConfig(current, config),
    sendText,
    beforeSendAttempt,
    deliver,
    request,
  };
}

describe("final delivery after plugin replacement", () => {
  const state = installDeliveryQueueTmpDirHooks();
  beforeEach(() => vi.stubEnv("OPENCLAW_STATE_DIR", state.tmpDir()));
  afterEach(() => {
    resetPluginRuntimeStateForTest();
    vi.unstubAllEnvs();
  });

  it("keeps the final caller pending until saved rich text is recovered", async () => {
    const { request, sendText, deliver } = await replacementFixture({ sameGeneration: true });
    request.payload = { text: "**Saved final** with [a link](https://example.com)" };
    const retryStarted = createDeferred();
    const retryResult = createDeferred<{ messageId: string }>();
    sendText
      .mockRejectedValueOnce(new Error("network request failed", { cause: connectionReset() }))
      .mockImplementationOnce(async () => {
        retryStarted.resolve();
        return await retryResult.promise;
      });
    let settled = false;
    const delivery = deliver(true).then((result) => {
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
      expect(sendText.mock.calls.map(([ctx]) => ctx.text)).toEqual([
        request.payload.text,
        request.payload.text,
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

  it("retains the accepted chunk when the final retry fails without replaying it", async () => {
    const { sendText, deliver } = await replacementFixture({ sameGeneration: true });
    const accepted = "accepted-retry-chunk";
    sendText.mockRejectedValueOnce(connectionReset()).mockImplementationOnce(async (ctx) => {
      await ctx.onDeliveryResult?.({
        messageId: accepted,
        receipt: {
          primaryPlatformMessageId: accepted,
          platformMessageIds: [accepted],
          parts: [{ platformMessageId: accepted, kind: "text", index: 0 }],
          sentAt: 1,
        },
      });
      throw new Error("second retry chunk rejected");
    });
    await expect(deliver()).resolves.toMatchObject({
      status: "failed",
      sentBeforeError: true,
      error: {
        message: "second retry chunk rejected",
        deliveryResult: { visibleReplySent: true, messageIds: [accepted] },
        cause: {
          results: [expect.objectContaining({ messageId: accepted })],
          payloadOutcomes: [expect.objectContaining({ status: "failed", sentBeforeError: true })],
        },
      },
    });
    expect(sendText).toHaveBeenCalledTimes(2);
    expect(await loadPendingDeliveries(state.tmpDir())).toEqual([]);
  });

  it.each(["backoff", "preparation"] as const)(
    "blocks the retry when its runtime is superseded during %s",
    async (phase) => {
      const fixture = await replacementFixture({ sameGeneration: true });
      fixture.sendText.mockRejectedValueOnce(connectionReset());
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
    { text: "Choose", channelData: { buttons: [["yes"]] } },
  ])("does not replay side-effect or media finals: $text", async (payload) => {
    const fixture = await replacementFixture({ sameGeneration: true });
    fixture.request.payload = payload;
    fixture.sendText.mockRejectedValue(connectionReset());
    await expect(fixture.deliver()).resolves.toMatchObject({ status: "failed" });
    expect(fixture.sendText).toHaveBeenCalledTimes(1);
  });

  it.each(["structured final", "message tool"])(
    "preserves final custody for %s",
    async (source) => {
      const tool = source === "message tool";
      const fixture = await replacementFixture({ sameGeneration: tool });
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
      const completion = expectDefined(
        resolvePendingFinalDeliveryCompletion([fixture.request.payload]),
        "pending-final custody",
      );
      const expectCustody = (deliveryState: "prepared" | "delivered") =>
        expect(loadSessionEntry(locator)?.pendingFinalDelivery?.deliveries).toEqual([
          {
            id: completion.deliveryId,
            state: deliveryState,
            ...(deliveryState === "delivered"
              ? { receipt: { platformMessageId: "accepted-final", resultCount: 1 } }
              : {}),
          },
        ]);
      expectCustody("prepared");
      if (tool) {
        fixture.sendText.mockRejectedValueOnce(connectionReset());
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
      const result = await fixture.deliver(true);
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
          cfg: successorConfig,
          to: "12345",
          text: "Saved final answer",
          accountId: "default",
        }),
      );
      expectCustody("delivered");
      expect(await loadPendingDeliveries(state.tmpDir())).toEqual([]);
      await clearPendingFinalDeliveryAfterSuccess(completion);
      expect(loadSessionEntry(locator)?.pendingFinalDelivery).toBeUndefined();
    },
  );

  type Fixture = Awaited<ReturnType<typeof replacementFixture>>;
  const supersedeBeforeSend = (fixture: Fixture) =>
    fixture.beforeSendAttempt.mockImplementation(async () => {
      fixture.publication.current = undefined;
    });
  const runtimeChanges: Record<string, (fixture: Fixture) => unknown> = {
    "replaced-channel": ({ current }) =>
      (current.channels = current.channels.map((entry) => ({
        ...entry,
        plugin: { ...entry.plugin },
      }))),
    "plugin-id-changed": ({ current }) =>
      (current.channels = current.channels.map((entry) => ({
        ...entry,
        pluginId: "another-owner",
      }))),
    closed: ({ publication }) => (publication.current = undefined),
    removed: ({ current }) => (current.channels = []),
    "account-changed": ({ setConfig: configure }) =>
      configure({ channels: { telegram: { enabled: false } } }),
    "defaults-changed": ({ setConfig: configure }) =>
      configure({
        channels: { ...cfg.channels, defaults: { groupPolicy: "disabled" } },
      }),
    "plugin-changed": ({ setConfig: configure }) =>
      configure({
        ...cfg,
        plugins: { entries: { telegram: { enabled: false } } },
      }),
    "new-channel": () => {},
    "missing-admission-config": () => {},
    "superseded-before-send": supersedeBeforeSend,
    "superseded-live-send": supersedeBeforeSend,
    "superseded-prepared-send": supersedeBeforeSend,
  };
  it.each(Object.keys(runtimeChanges))(
    "does not send or borrow the process root when %s",
    async (stateChange) => {
      const fixture = await replacementFixture({
        newChannel: stateChange === "new-channel",
        sameGeneration: stateChange === "superseded-prepared-send",
        missingAdmissionConfig: stateChange === "missing-admission-config",
      });
      setActivePluginRegistry(createTestRegistry([...fixture.current.channels]));
      runtimeChanges[stateChange]?.(fixture);
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
    },
  );

  it("uses publication settings through prepared views and current policy for delivery", async () => {
    const { request, turn, setConfig: configure, deliver, sendText } = await replacementFixture();
    const withPrefix = (config: OpenClawConfig) => ({
      ...config,
      channels: { telegram: { ...config.channels?.telegram, responsePrefix: "[ACCOUNT]" } },
    });
    request.cfg = withPrefix(cfg);
    const currentConfig: OpenClawConfig = {
      ...cfg,
      tools: { fs: { workspaceOnly: true } },
    };
    configure(currentConfig);
    setConfig(turn, request.cfg);
    request.prepareRuntimeHandoff = withPrefix;
    await expect(deliver()).resolves.toMatchObject({ status: "handled_visible" });
    expect(sendText).toHaveBeenCalledExactlyOnceWith(
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
const secretEnv = "TELEGRAM_TEST_RELOAD_TOKEN";

describe("Telegram final sender after registry replacement", () => {
  const http = createTelegramDispatchHttpFixture();
  afterEach(() => vi.unstubAllEnvs());

  it.each(["unchanged", "environment", "token-file", "secret-ref"] as const)(
    "keeps the admitted bot when credentials are %s",
    async (source) => {
      const old = expectDefined(getActivePluginRegistry(), "Telegram registry");
      let owner: ReturnType<typeof createPluginRegistryOwner> | undefined;
      const next = createTestRegistry([...old.channels]);
      const tokenFile = http.state.path("telegram-token");
      const credentials: Record<typeof source, TelegramAccountConfig> = {
        unchanged: {},
        environment: { botToken: undefined },
        "token-file": { botToken: undefined, tokenFile },
        "secret-ref": { botToken: { source: "env", provider: "reload", id: secretEnv } },
      };
      const writeToken = (token: string) => fs.writeFile(tokenFile, token, { mode: 0o600 });
      if (source === "token-file") {
        await writeToken(http.token);
      }
      vi.stubEnv("TELEGRAM_BOT_TOKEN", http.token);
      vi.stubEnv(secretEnv, http.token);
      try {
        await withPluginRuntimeRegistryScope(old, () =>
          http.dispatchProgressTurn(
            async () => {
              if (source === "token-file") {
                await writeToken(replacementToken);
              } else if (source !== "unchanged") {
                vi.stubEnv(
                  source === "secret-ref" ? secretEnv : "TELEGRAM_BOT_TOKEN",
                  replacementToken,
                );
              }
              setActivePluginRegistry(next);
              expectDefined(owner, "publication owner").publish(next);
              // Another Gateway's process projection is never our delivery owner.
              setActivePluginRegistry(createTestRegistry([]));
            },
            {
              mode: "off",
              toolProgress: false,
              finalReply: { text: finalText },
              allowErrors: source !== "unchanged",
              telegramCfg: credentials[source],
              cfg: {
                secrets: {
                  providers: {
                    reload: { source: "env", allowlist: [secretEnv] },
                  },
                },
              },
              onDispatch(dispatchConfig) {
                for (const registry of [old, next]) {
                  setConfig(registry, dispatchConfig);
                }
                owner = createPluginRegistryOwner(old);
              },
            },
          ),
        );
        const finals = http.calls.filter(
          (call) => call.method === "sendMessage" && call.fields.text === finalText,
        );
        const admitted = source === "unchanged";
        expect({
          finals: finals.length,
          visible: [...http.visibleMessages.values()].includes(finalText),
        }).toEqual({ finals: admitted ? 1 : 0, visible: admitted });
        if (admitted) {
          expect(http.endpoints[http.calls.findIndex((call) => call === finals[0])]).toBe(
            "/bot" + http.token + "/sendMessage",
          );
        }
        expect(http.endpoints.some((endpoint) => endpoint.includes(replacementToken))).toBe(false);
      } finally {
        await owner?.close();
      }
    },
  );
});
