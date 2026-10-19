import assert from "node:assert/strict";
import type { ServerResponse } from "node:http";
import path from "node:path";
import { setImmediate as nextTurn } from "node:timers/promises";
import { expect, it } from "vitest";
import { telegramOutbound, telegramPlugin } from "../extensions/telegram/api.js";
import { getOrCreateAccountThrottler } from "../extensions/telegram/test-api.js";
import {
  announceRestartRecoveryResumption,
  prepareRestartRecoveryDeliveryCurrent,
} from "../src/agents/main-session-recovery/main-session-restart-recovery-delivery.js";
import type { ChannelHeartbeatAdapter } from "../src/channels/plugins/types.adapters.js";
import { replaceSessionEntry } from "../src/config/sessions/session-accessor.js";
import type { OpenClawConfig } from "../src/config/types.openclaw.js";
import { createGatewayInstanceRuntime } from "../src/gateway/server-instance-runtime.js";
import type { GatewayRecoveryRuntime } from "../src/gateway/server-instance-runtime.types.js";
import type { GatewayRequestContext } from "../src/gateway/server-methods/types.js";
import { getAgentEventLifecycleGeneration } from "../src/infra/agent-events.js";
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

async function createRecovery(
  stateDir: string,
  kind: "notice" | "typing",
  cfg: OpenClawConfig,
  plugin = telegramPlugin,
) {
  const scope = {
    agentId: "main",
    storePath: path.join(stateDir, "openclaw-agent.sqlite"),
    sessionKey: `agent:main:telegram:${kind === "notice" ? "direct:123" : "group:-100123:topic:99"}`,
    sessionId: `${kind}-session`,
    recoveryRunId: `${kind}-run`,
    lifecycleGeneration: getAgentEventLifecycleGeneration(),
    deliveryContext: {
      channel: "telegram",
      to: kind === "notice" ? "123" : "-100123",
      accountId: "default",
      ...(kind === "typing" ? { threadId: 99 } : {}),
    },
  };
  const writeEntry = (fields: Partial<Parameters<typeof replaceSessionEntry>[1]>) =>
    replaceSessionEntry(
      { storePath: scope.storePath, sessionKey: scope.sessionKey },
      {
        sessionId: scope.sessionId,
        updatedAt: Date.now(),
        restartRecoveryDeliveryContext: scope.deliveryContext,
        ...fields,
      },
    );
  await writeEntry({ restartRecoveryDeliveryRunId: scope.recoveryRunId });
  const snapshot = captureActivePluginRegistrySnapshot();
  stageActivePluginRegistry(
    createTestRegistry([{ pluginId: "telegram", source: "test", plugin }]),
    null,
    "default",
  );
  const settings = { currentCfg: cfg };
  const runtime = createGatewayInstanceRuntime({
    getContext: () =>
      ({ deps: {}, getRuntimeConfig: () => settings.currentCfg }) as GatewayRequestContext,
    getMethodRegistry: () => {
      throw new Error(`${kind} must not use RPC`);
    },
    isDispatchAvailable: () => true,
  });
  const restore = () => restoreActivePluginRegistrySnapshot(snapshot);
  return { scope, runtime, settings, restore, writeEntry };
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
it.each([
  "allowed",
  "gateway closed",
  "policy revoked",
  "production allowed",
  "runtime policy revoked",
  "automatic delivery revoked",
  "owner retired",
] as const)("checks %s after a real serialized account queue wait", async (mode) => {
  await withOpenClawTestState({ prefix: "notice-http-" }, async ({ stateDir }) => {
    const preDispatch = createDeferredCore();
    const productionPredicate = !["allowed", "gateway closed", "policy revoked"].includes(mode);
    const noticeText = productionPredicate
      ? "I'm continuing your interrupted request now (the gateway has just restarted).  Don't be concerned with the lack of typing; I am working behind the scenes and I'll send a message when I'm done!"
      : "Recovery resumed";
    const api = await startApi(stateDir, "notice");
    const { cfg, blocked, blockerText } = api;
    const { scope, runtime, settings, restore, writeEntry } = await createRecovery(
      stateDir,
      "notice",
      cfg,
    );
    const sendText = telegramOutbound.sendText;
    assert(sendText, "Missing Telegram sender");
    let policyCurrent = true;
    let checks = 0;
    let held: ServerResponse | undefined;
    const blocker = sendText({ cfg, to: "123", accountId: "default", text: blockerText });
    let notice: Promise<{ result?: { suppressed: boolean }; error?: unknown }> | undefined;
    try {
      held = await beforeCompletion(blocked.promise, blocker, "Predecessor did not reach HTTP");
      const observedSend: GatewayRecoveryRuntime["sendRecoveryNotice"] = (payload) =>
        runtime.recovery.sendRecoveryNotice({
          ...payload,
          isCurrent: (...args) => {
            checks++;
            if (checks >= 2) {
              preDispatch.resolve();
            }
            return payload.isCurrent?.(...args) ?? true;
          },
        });
      const operation = productionPredicate
        ? announceRestartRecoveryResumption({
            ...scope,
            cfg,
            gatewayRuntime: { ...runtime.recovery, sendRecoveryNotice: observedSend },
          })
        : observedSend({
            channel: "telegram",
            to: "123",
            accountId: "default",
            text: noticeText,
            idempotencyKey: "notice-" + mode,
            liveOnly: true,
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
      if (mode === "runtime policy revoked") {
        settings.currentCfg = { ...cfg, session: { sendPolicy: { default: "deny" } } };
      }
      if (mode === "automatic delivery revoked" || mode === "owner retired") {
        await writeEntry(
          mode === "owner retired"
            ? { status: "done" }
            : {
                restartRecoveryDeliveryRunId: scope.recoveryRunId,
                restartRecoverySourceReplyDeliveryMode: "message_tool_only",
              },
        );
      }
      api.release(held);
      await blocker;
      const outcome = await notice;
      const allowed = mode === "allowed" || mode === "production allowed";
      if (mode === "allowed") {
        expect(outcome).toEqual({ result: { suppressed: false } });
      } else if (!allowed && !productionPredicate) {
        expect(outcome.error).toBeDefined();
      }
      const expected = allowed ? [blockerText, noticeText] : [blockerText];
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
});
it.each([
  "allowed",
  "completed",
  "session replaced",
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
    const { scope, runtime, settings, restore } = await createRecovery(
      stateDir,
      "typing",
      cfg,
      plugin,
    );
    const predecessor = Promise.resolve(
      originalTyping({ cfg, to: "-100123", accountId: "default", threadId: 1 }),
    );
    let held: ServerResponse | undefined;
    let stop: (() => void) | undefined;
    let deliveryCurrent:
      | Awaited<ReturnType<typeof prepareRestartRecoveryDeliveryCurrent>>
      | undefined;
    try {
      held = await beforeCompletion(blocked.promise, predecessor, "Predecessor did not enter HTTP");
      deliveryCurrent = await prepareRestartRecoveryDeliveryCurrent(scope);
      stop = runtime.recovery.startRecoveryTyping?.({
        ...scope.deliveryContext,
        runId: scope.recoveryRunId,
        isCurrent: deliveryCurrent.isCurrent,
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
      if (mode === "session replaced") {
        await replaceSessionEntry(
          { storePath: scope.storePath, sessionKey: scope.sessionKey },
          { sessionId: "replacement-session", updatedAt: Date.now() },
        );
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
      deliveryCurrent?.release();
      runtime.close();
      restore();
      await api.close();
    }
  });
});
