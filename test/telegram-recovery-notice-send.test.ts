import { createServer, type ServerResponse } from "node:http";
import type { AddressInfo, Socket } from "node:net";
import path from "node:path";
import { describe, expect, it } from "vitest";
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

function accept(response: ServerResponse, result: unknown = true) {
  response.setHeader("content-type", "application/json");
  response.end(JSON.stringify({ ok: true, result }));
}

async function startApi(
  stateDir: string,
  prefix: string,
  receive: (payload: TelegramPayload, response: ServerResponse) => void,
) {
  const sockets = new Set<Socket>();
  const server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => receive(JSON.parse(Buffer.concat(chunks).toString("utf8")), response));
  });
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
  });
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });
  const botToken = `123:${prefix}-${stateDir.split("/").at(-1)}`;
  getOrCreateAccountThrottler(botToken, createImmediateSerialThrottler);
  const cfg: OpenClawConfig = {
    channels: {
      telegram: { botToken, apiRoot: `http://127.0.0.1:${(server.address() as AddressInfo).port}` },
    },
  };
  return {
    cfg,
    close: async () => {
      for (const socket of sockets) {
        socket.destroy();
      }
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
      });
    },
  };
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
    sessionKey:
      kind === "notice"
        ? "agent:main:telegram:direct:123"
        : "agent:main:telegram:group:-100123:topic:99",
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
  await replaceSessionEntry(
    { storePath: scope.storePath, sessionKey: scope.sessionKey },
    {
      sessionId: scope.sessionId,
      updatedAt: Date.now(),
      restartRecoveryDeliveryRunId: scope.recoveryRunId,
      restartRecoveryDeliveryContext: scope.deliveryContext,
    },
  );
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
  return { scope, runtime, settings, restore: () => restoreActivePluginRegistrySnapshot(snapshot) };
}

const nextTurn = () =>
  new Promise<void>((resolve) => {
    setImmediate(resolve);
  });

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
describe("recovery notice final transport fence", () => {
  it.each([
    "allowed",
    "gateway closed",
    "policy revoked",
    "production allowed",
    "runtime policy revoked",
    "automatic delivery revoked",
    "owner retired",
  ] as const)("checks %s after a real serialized account queue wait", async (mode) => {
    await withOpenClawTestState({ prefix: "notice-http-" }, async (state) => {
      const blocked = createDeferredCore<ServerResponse>();
      const preDispatch = createDeferredCore();
      const requests: string[] = [];
      const visible: string[] = [];
      const blockerText = "Independent throttle predecessor";
      const productionPredicate =
        mode === "production allowed" ||
        mode === "runtime policy revoked" ||
        mode === "automatic delivery revoked" ||
        mode === "owner retired";
      const noticeText = productionPredicate
        ? "I'm continuing your interrupted request now (the gateway has just restarted).  Don't be concerned with the lack of typing; I am working behind the scenes and I'll send a message when I'm done!"
        : "Recovery resumed";
      const acceptMessage = (response: ServerResponse, text: string) => {
        visible.push(text);
        accept(response, {
          message_id: visible.length,
          date: 1,
          chat: { id: 123, type: "private", first_name: "Fixture" },
          text,
        });
      };
      const api = await startApi(state.stateDir, "notice", (payload, response) => {
        const text = payload.text ?? "";
        requests.push(text);
        if (text === blockerText) {
          blocked.resolve(response);
        } else {
          acceptMessage(response, text);
        }
      });
      const { cfg } = api;
      const { scope, runtime, settings, restore } = await createRecovery(
        state.stateDir,
        "notice",
        cfg,
      );
      const sendText = telegramOutbound.sendText;
      if (!sendText) {
        throw new Error("Missing Telegram sender");
      }
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
        expect(requests).toEqual([blockerText]);
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
          await replaceSessionEntry(
            { storePath: scope.storePath, sessionKey: scope.sessionKey },
            {
              sessionId: scope.sessionId,
              updatedAt: Date.now(),
              ...(mode === "owner retired"
                ? { status: "done" as const }
                : { restartRecoveryDeliveryRunId: scope.recoveryRunId }),
              restartRecoveryDeliveryContext: scope.deliveryContext,
              ...(mode === "automatic delivery revoked"
                ? { restartRecoverySourceReplyDeliveryMode: "message_tool_only" as const }
                : {}),
            },
          );
        }
        acceptMessage(held, blockerText);
        await blocker;
        const outcome = await notice;
        const allowed = mode === "allowed" || mode === "production allowed";
        if (allowed) {
          if (mode === "allowed") {
            expect(outcome).toEqual({ result: { suppressed: false } });
          }
        } else if (!productionPredicate) {
          expect(outcome.error).toBeDefined();
        }
        const expected = allowed ? [blockerText, noticeText] : [blockerText];
        expect(visible).toEqual(expected);
        expect(requests).toEqual(expected);
      } finally {
        if (held && !held.writableEnded) {
          acceptMessage(held, blockerText);
        }
        await Promise.allSettled([blocker, ...(notice ? [notice] : [])]);
        runtime.close();
        restore();
        await api.close();
      }
    });
  });
});

describe("recovery typing final transport fence", () => {
  it.each([
    "allowed",
    "completed",
    "session replaced",
    "runtime policy revoked",
    "gateway closed",
    "typing disabled",
  ] as const)("checks %s after a real group action queue wait", async (mode) => {
    await withOpenClawTestState({ prefix: "typing-http-" }, async (state) => {
      const blocked = createDeferredCore<ServerResponse>();
      const started = createDeferredCore();
      const finished = createDeferredCore();
      const requests: TelegramPayload[] = [];
      const api = await startApi(state.stateDir, "typing", (payload, response) => {
        requests.push(payload);
        if (requests.length === 1) {
          blocked.resolve(response);
        } else {
          accept(response);
        }
      });
      const cfg: OpenClawConfig = {
        ...api.cfg,
        agents: { defaults: { timeoutSeconds: 30 } },
      };
      const originalTyping = telegramPlugin.heartbeat?.sendTyping;
      if (!originalTyping) {
        throw new Error("Missing original Telegram typing hook");
      }
      const guardedTyping = telegramPlugin.heartbeat?.sendTypingGuarded;
      if (!guardedTyping) {
        throw new Error("Missing guarded Telegram typing hook");
      }
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
      const { scope, runtime, settings, restore } = await createRecovery(
        state.stateDir,
        "typing",
        cfg,
        {
          ...telegramPlugin,
          heartbeat: { ...telegramPlugin.heartbeat, sendTypingGuarded: trackedTyping },
        },
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
        held = await beforeCompletion(
          blocked.promise,
          predecessor,
          "Predecessor did not enter HTTP",
        );
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
        accept(held);
        await predecessor;
        await finished.promise;
        stop?.();
        // An independent allowed topic request drains the same FIFO action queue.
        // Cancellation must not merely resolve early and leave a stale post behind.
        await originalTyping({ cfg, to: "-100123", accountId: "default", threadId: 177 });
        expect(requests.at(-1)).toMatchObject({
          action: "typing",
          chat_id: "-100123",
          message_thread_id: 177,
        });
        expect(requests).toHaveLength(mode === "allowed" ? 3 : 2);
        if (mode === "allowed") {
          expect(requests[1]).toMatchObject({
            action: "typing",
            chat_id: "-100123",
            message_thread_id: 99,
          });
        }
      } finally {
        if (held && !held.writableEnded) {
          accept(held);
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
});
