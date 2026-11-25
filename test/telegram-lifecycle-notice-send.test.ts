import assert from "node:assert/strict";
import type { ServerResponse } from "node:http";
import path from "node:path";
import { setImmediate as nextTurn } from "node:timers/promises";
import { expect, it } from "vitest";
import { telegramOutbound, telegramPlugin } from "../extensions/telegram/api.js";
import { getOrCreateAccountThrottler } from "../extensions/telegram/test-api.js";
import type { ChannelHeartbeatAdapter } from "../src/channels/plugins/types.adapters.js";
import { loadSessionEntry, replaceSessionEntry } from "../src/config/sessions/session-accessor.js";
import type { OpenClawConfig } from "../src/config/types.openclaw.js";
import { createGatewayInstanceRuntime } from "../src/gateway/server-instance-runtime.js";
import type { GatewayLifecycleRuntime } from "../src/gateway/server-instance-runtime.types.js";
import { createContext } from "../src/gateway/server-plugin-in-process-dispatch.test-support.js";
import { deliverOutboundPayloads } from "../src/infra/outbound/deliver.js";
import { drainPendingDeliveriesCore } from "../src/infra/outbound/delivery-queue-recovery.js";
import { loadUnfinishedDeliveries } from "../src/infra/outbound/delivery-queue-storage.js";
import { createPendingFinalFixture } from "../src/infra/outbound/delivery-queue.test-helpers.js";
import {
  captureActivePluginRegistrySnapshot,
  restoreActivePluginRegistrySnapshot,
  stageActivePluginRegistry,
} from "../src/plugins/runtime.js";
import { createDeferredCore } from "../src/shared/deferred.js";
import { createTestRegistry } from "../src/test-utils/channel-plugins.js";
import { withOpenClawTestState } from "../src/test-utils/openclaw-test-state.js";
import { replyJson, startJsonLoopback } from "./telegram-http.test-support.js";

type TelegramApiTransformer = ReturnType<typeof getOrCreateAccountThrottler>["transformer"];

function createImmediateSerialThrottler(): TelegramApiTransformer {
  let tail = Promise.resolve();
  return (prev, method, payload, signal) => {
    const result = tail.then(() => prev(method, payload, signal));
    tail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  };
}

type TelegramPayload = {
  text?: string;
  action?: string;
  chat_id?: string | number;
  message_thread_id?: number;
};

async function startApi(stateDir: string, kind: "notice" | "typing") {
  const blocked = createDeferredCore<ServerResponse>();
  const requests: TelegramPayload[] = [];
  const visible: string[] = [];
  const blockerText = "Independent throttle predecessor";
  const release = (response: ServerResponse, text = blockerText) => {
    if (kind === "notice") {
      visible.push(text);
    }
    const result =
      kind === "typing"
        ? true
        : {
            message_id: visible.length,
            date: 1,
            chat: { id: 123, type: "private", first_name: "Fixture" },
            text,
          };
    replyJson(response, { ok: true, result });
  };
  const { url: apiRoot, close } = await startJsonLoopback((body, response) => {
    const payload: TelegramPayload = JSON.parse(body);
    requests.push(payload);
    const text = payload.text ?? "";
    if (kind === "notice" ? text === blockerText : requests.length === 1) {
      blocked.resolve(response);
    } else {
      release(response, text);
    }
  });
  const botToken = `123:${kind}-${stateDir.split("/").at(-1)}`;
  getOrCreateAccountThrottler(botToken, createImmediateSerialThrottler);
  const cfg: OpenClawConfig = { channels: { telegram: { botToken, apiRoot } } };
  const texts = () => requests.map((payload) => payload.text ?? "");
  return { cfg, close, blocked, requests, visible, blockerText, release, texts };
}

function createLifecycle(kind: "notice" | "typing", cfg: OpenClawConfig, plugin = telegramPlugin) {
  const deliveryContext = {
    channel: "telegram",
    to: kind === "notice" ? "123" : "-100123",
    accountId: "default",
    ...(kind === "typing" ? { threadId: 99 } : {}),
  };
  const snapshot = captureActivePluginRegistrySnapshot();
  stageActivePluginRegistry(
    createTestRegistry([{ pluginId: "telegram", source: "test", plugin }]),
    null,
    "default",
  );
  const settings = { currentCfg: cfg };
  const context = createContext([], () => settings.currentCfg);
  context.deps = {};
  const runtime = createGatewayInstanceRuntime({
    getContext: () => context,
    getMethodRegistry: () => {
      throw new Error(`${kind} must not use RPC`);
    },
    isDispatchAvailable: () => true,
  });
  const restore = () => restoreActivePluginRegistrySnapshot(snapshot);
  return { deliveryContext, runtime, settings, restore };
}

function beforeCompletion<T>(signal: Promise<T>, operation: Promise<unknown>, message: string) {
  return Promise.race([
    signal,
    operation.then(() => {
      throw new Error(message);
    }),
  ]);
}

// External HTTP and rate delays are substituted; Gateway ownership, Telegram's client, and the
// serialized account queue remain real.
it.each(["allowed", "gateway closed", "policy revoked"] as const)(
  "checks %s after a real serialized account queue wait",
  async (mode) => {
    await withOpenClawTestState({ prefix: "notice-http-" }, async ({ stateDir }) => {
      const preDispatch = createDeferredCore();
      const noticeText = "Lifecycle notice";
      const api = await startApi(stateDir, "notice");
      const { cfg, blocked, blockerText } = api;
      const { runtime, restore } = createLifecycle("notice", cfg);
      const sendText = telegramOutbound.sendText;
      assert(sendText, "Missing Telegram sender");
      let policyCurrent = true;
      let checks = 0;
      let held: ServerResponse | undefined;
      const blocker = sendText({ cfg, to: "123", accountId: "default", text: blockerText });
      let notice: Promise<{ result?: { suppressed: boolean }; error?: unknown }> | undefined;
      try {
        held = await beforeCompletion(blocked.promise, blocker, "Predecessor did not reach HTTP");
        const observedSend: GatewayLifecycleRuntime["sendNotice"] = (payload) =>
          runtime.lifecycle.sendNotice({
            ...payload,
            isCurrent: (...args) => {
              checks++;
              if (checks >= 2) {
                preDispatch.resolve();
              }
              return payload.isCurrent?.(...args) ?? true;
            },
          });
        const operation = observedSend({
          channel: "telegram",
          to: "123",
          accountId: "default",
          text: noticeText,
          idempotencyKey: "notice-" + mode,
          isCurrent: () => policyCurrent,
        });
        notice = operation.then(
          (result) => ({ result: result ?? undefined }),
          (error: unknown) => ({ error }),
        );
        await beforeCompletion(
          preDispatch.promise,
          notice,
          "Notice did not reach its pre-dispatch check",
        );
        // Finish the synchronous pre-dispatch continuation before changing its owner.
        await nextTurn();
        expect(api.texts()).toEqual([blockerText]);
        if (mode === "gateway closed") {
          runtime.close();
        }
        if (mode === "policy revoked") {
          policyCurrent = false;
        }
        api.release(held);
        await blocker;
        const outcome = await notice;
        if (mode === "allowed") {
          expect(outcome).toEqual({ result: { suppressed: false } });
        } else {
          expect(outcome.error).toBeDefined();
        }
        const expected = mode === "allowed" ? [blockerText, noticeText] : [blockerText];
        expect([api.visible, api.texts()]).toEqual([expected, expected]);
      } finally {
        if (held && !held.writableEnded) {
          api.release(held);
        }
        await Promise.allSettled([blocker, ...(notice ? [notice] : [])]);
        runtime.close();
        restore();
        await api.close();
      }
    });
  },
);
it.each([
  "allowed",
  "completed",
  "source retired",
  "runtime policy revoked",
  "gateway closed",
  "typing disabled",
] as const)("checks %s after a real group action queue wait", async (mode) => {
  await withOpenClawTestState({ prefix: "typing-http-" }, async ({ stateDir }) => {
    const started = createDeferredCore();
    const finished = createDeferredCore();
    const api = await startApi(stateDir, "typing");
    const { blocked, requests } = api;
    const typingAt = (index: number) => {
      const request = requests.at(index);
      return [request?.action, request?.chat_id, request?.message_thread_id];
    };
    const cfg: OpenClawConfig = { ...api.cfg, agents: { defaults: { timeoutSeconds: 30 } } };
    const originalTyping = telegramPlugin.heartbeat?.sendTyping;
    assert(originalTyping, "Missing original Telegram typing hook");
    const guardedTyping = telegramPlugin.heartbeat?.sendTypingGuarded;
    assert(guardedTyping, "Missing guarded Telegram typing hook");
    const trackedTyping: NonNullable<ChannelHeartbeatAdapter["sendTypingGuarded"]> = async (
      params,
    ) => {
      started.resolve();
      try {
        await guardedTyping(params);
      } finally {
        finished.resolve();
      }
    };
    const plugin = {
      ...telegramPlugin,
      heartbeat: { ...telegramPlugin.heartbeat, sendTypingGuarded: trackedTyping },
    };
    const { deliveryContext, runtime, settings, restore } = createLifecycle("typing", cfg, plugin);
    const predecessor = Promise.resolve(
      originalTyping({ cfg, to: "-100123", accountId: "default", threadId: 1 }),
    );
    let held: ServerResponse | undefined;
    let stop: (() => void) | undefined;
    let sourceCurrent = true;
    try {
      held = await beforeCompletion(blocked.promise, predecessor, "Predecessor did not enter HTTP");
      stop = runtime.lifecycle.startTyping?.({
        ...deliveryContext,
        runId: "typing-run",
        isCurrent: (currentCfg) =>
          sourceCurrent && currentCfg.session?.sendPolicy?.default !== "deny",
      });
      await started.promise;
      await nextTurn();
      expect(requests).toHaveLength(1);
      if (mode === "completed") {
        stop?.();
      }
      if (mode === "gateway closed") {
        runtime.close();
      }
      if (mode === "source retired") {
        sourceCurrent = false;
      }
      if (mode === "runtime policy revoked") {
        settings.currentCfg = { ...cfg, session: { sendPolicy: { default: "deny" } } };
      }
      if (mode === "typing disabled") {
        settings.currentCfg = {
          ...cfg,
          agents: { defaults: { timeoutSeconds: 30, typingMode: "never" } },
        };
      }
      api.release(held);
      await predecessor;
      await finished.promise;
      stop?.();
      // An independent allowed topic request drains the same FIFO action queue.
      // Cancellation must not merely resolve early and leave a stale post behind.
      await originalTyping({ cfg, to: "-100123", accountId: "default", threadId: 177 });
      expect(typingAt(-1)).toEqual(["typing", "-100123", 177]);
      expect(requests).toHaveLength(mode === "allowed" ? 3 : 2);
      if (mode === "allowed") {
        expect(typingAt(1)).toEqual(["typing", "-100123", 99]);
      }
    } finally {
      if (held && !held.writableEnded) {
        api.release(held);
      }
      await predecessor.catch(() => {});
      stop?.();
      runtime.close();
      restore();
      await api.close();
    }
  });
});

// A lost Bot API response must not replay the answer; recovery still owes the chat a notice.
it.each([false, true])(
  "delivers the owed notice when recovery stops a final (proven unsent: %s)",
  async (provenUnsent) => {
    await withOpenClawTestState({ prefix: "telegram-recovery-notice-" }, async (state) => {
      const answer = "Completed answer whose delivery cannot be confirmed";
      const visible: string[] = [];
      let answerAttempts = 0;
      const api = await startJsonLoopback((body, response) => {
        const payload: TelegramPayload = JSON.parse(body);
        if (payload.text === answer) {
          answerAttempts++;
          if (provenUnsent) {
            replyJson(
              response,
              { ok: false, error_code: 400, description: "Bad Request: message thread not found" },
              400,
            );
          } else {
            response.destroy();
          }
          return;
        }
        visible.push(payload.text ?? "");
        replyJson(response, {
          ok: true,
          result: {
            message_id: 100 + visible.length,
            date: 1,
            chat: { id: 123, type: "private" },
            text: payload.text,
          },
        });
      });
      const cfg: OpenClawConfig = {
        channels: {
          telegram: {
            botToken: "123456:restart-notice-fixture",
            apiRoot: api.url,
          },
        },
      };
      const { runtime, restore, deliveryContext } = createLifecycle("notice", cfg);
      const sessionKey = "agent:main:telegram:direct:123";
      const storePath = path.join(state.stateDir, "sessions.json");
      const { completion, entry } = createPendingFinalFixture(
        storePath,
        "restart-final",
        sessionKey,
        {
          text: answer,
          context: deliveryContext,
          now: Date.now(),
        },
      );
      try {
        await replaceSessionEntry(
          { sessionKey, storePath },
          {
            ...entry,
            delivery: {
              kind: "external",
              route: { channel: "telegram", accountId: "default" },
              context: deliveryContext,
              origin: {},
            },
          },
        );
        await expect(
          deliverOutboundPayloads({
            cfg,
            channel: "telegram",
            to: "123",
            accountId: "default",
            payloads: [{ text: answer }],
            queuePolicy: "required",
            deliveryIntentId: completion.deliveryId,
            deliveryCompletion: completion,
            maxRetries: 1,
          }),
        ).rejects.toThrow();
        expect(answerAttempts).toBe(1);
        expect(visible).toEqual([]);
        expect((await loadUnfinishedDeliveries(state.stateDir))[0]?.recoveryState).toBe(
          provenUnsent ? undefined : "unknown_after_send",
        );
        const log = { info() {}, warn() {}, error() {} };
        const recover = () =>
          drainPendingDeliveriesCore({
            cfg,
            stateDir: state.stateDir,
            log,
            deliver: deliverOutboundPayloads,
            drainKey: "telegram-restart-notice",
            logLabel: "recovery",
            selectEntry: () => ({ match: true, bypassBackoff: true }),
          });
        await recover();
        expect(answerAttempts).toBe(1);
        expect(await loadUnfinishedDeliveries(state.stateDir)).toEqual([]);
        expect(visible).toEqual([
          expect.stringContaining("I couldn’t confirm whether my previous reply"),
        ]);
        expect(loadSessionEntry({ sessionKey, storePath })?.pendingDeliveryNotice?.state).toBe(
          "acknowledged",
        );
        await recover();
        expect(visible).toHaveLength(1);
        expect(answerAttempts).toBe(1);
      } finally {
        runtime.close();
        restore();
        await api.close();
      }
    });
  },
);
