import { createServer, type ServerResponse } from "node:http";
import type { AddressInfo, Socket } from "node:net";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { telegramOutbound, telegramPlugin } from "../extensions/telegram/api.js";
import {
  announceRestartRecoveryResumption,
  isRestartRecoveryDeliveryCurrent,
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

// Only external HTTP is substituted: Gateway ownership and Telegram's client/throttler remain real.
describe("recovery notice final transport fence", () => {
  it.each([
    "allowed",
    "gateway closed",
    "policy revoked",
    "production allowed",
    "runtime policy revoked",
    "automatic delivery revoked",
    "owner retired",
  ] as const)("checks %s after a real account throttle wait", async (mode) => {
    await withOpenClawTestState({ prefix: "notice-http-" }, async (state) => {
      const blocked = createDeferredCore<ServerResponse>();
      const preDispatch = createDeferredCore();
      const requests: string[] = [];
      const visible: string[] = [];
      const sockets = new Set<Socket>();
      const blockerText = "Independent throttle predecessor";
      const productionPredicate =
        mode === "production allowed" ||
        mode === "runtime policy revoked" ||
        mode === "automatic delivery revoked" ||
        mode === "owner retired";
      const noticeText = productionPredicate
        ? "I'm continuing your interrupted request after the gateway restart. I'll post the result here."
        : "Recovery resumed";
      const accept = (response: ServerResponse, text: string) => {
        visible.push(text);
        response.setHeader("content-type", "application/json");
        response.end(
          JSON.stringify({
            ok: true,
            result: {
              message_id: visible.length,
              date: 1,
              chat: { id: 123, type: "private", first_name: "Fixture" },
              text,
            },
          }),
        );
      };
      const server = createServer((request, response) => {
        const chunks: Buffer[] = [];
        request.on("data", (chunk: Buffer) => chunks.push(chunk));
        request.on("end", () => {
          const payload = JSON.parse(Buffer.concat(chunks).toString("utf8")) as { text?: string };
          const text = payload.text ?? "";
          requests.push(text);
          if (text === blockerText) {
            blocked.resolve(response);
          } else {
            accept(response, text);
          }
        });
      });
      server.on("connection", (socket) => {
        sockets.add(socket);
        socket.on("close", () => sockets.delete(socket));
      });
      await new Promise<void>((resolve) => {
        server.listen(0, "127.0.0.1", resolve);
      });
      const cfg: OpenClawConfig = {
        channels: {
          telegram: {
            botToken: "123:notice-" + state.stateDir.split("/").at(-1),
            apiRoot: "http://127.0.0.1:" + (server.address() as AddressInfo).port,
          },
        },
      };
      let currentCfg = cfg;
      const sessionKey = "agent:main:telegram:direct:123";
      const storePath = path.join(state.stateDir, "sessions.json");
      const scope = {
        storePath,
        sessionKey,
        sessionId: "notice-session",
        recoveryRunId: "notice-run",
        lifecycleGeneration: getAgentEventLifecycleGeneration(),
        deliveryContext: { channel: "telegram", to: "123", accountId: "default" },
      };
      await replaceSessionEntry(
        { storePath, sessionKey },
        {
          sessionId: scope.sessionId,
          updatedAt: Date.now(),
          status: "running",
          restartRecoveryDeliveryRunId: scope.recoveryRunId,
          restartRecoveryDeliveryContext: scope.deliveryContext,
        },
      );
      const snapshot = captureActivePluginRegistrySnapshot();
      stageActivePluginRegistry(
        createTestRegistry([{ pluginId: "telegram", source: "test", plugin: telegramPlugin }]),
        null,
        "default",
      );
      const runtime = createGatewayInstanceRuntime({
        getContext: () =>
          ({ deps: {}, getRuntimeConfig: () => currentCfg }) as GatewayRequestContext,
        getMethodRegistry: () => {
          throw new Error("Notice must not use RPC");
        },
        isDispatchAvailable: () => true,
      });
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
        held = await Promise.race([
          blocked.promise,
          blocker.then(() => {
            throw new Error("Predecessor did not reach HTTP");
          }),
        ]);
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
        await Promise.race([
          preDispatch.promise,
          notice.then(() => {
            throw new Error("Notice did not reach its pre-dispatch check");
          }),
        ]);
        // Finish the synchronous pre-dispatch continuation before changing its owner.
        await new Promise<void>((resolve) => {
          setImmediate(resolve);
        });
        expect(requests).toEqual([blockerText]);
        if (mode === "gateway closed") {
          runtime.close();
        }
        if (mode === "policy revoked") {
          policyCurrent = false;
        }
        if (mode === "runtime policy revoked") {
          currentCfg = { ...cfg, session: { sendPolicy: { default: "deny" } } };
        }
        if (mode === "automatic delivery revoked" || mode === "owner retired") {
          await replaceSessionEntry(
            { storePath, sessionKey },
            {
              sessionId: scope.sessionId,
              updatedAt: Date.now(),
              status: mode === "owner retired" ? "done" : "running",
              restartRecoveryDeliveryRunId: scope.recoveryRunId,
              restartRecoveryDeliveryContext: scope.deliveryContext,
              ...(mode === "automatic delivery revoked"
                ? { restartRecoverySourceReplyDeliveryMode: "message_tool_only" as const }
                : {}),
            },
          );
        }
        accept(held, blockerText);
        await blocker;
        const outcome = await notice;
        if (mode === "allowed" || mode === "production allowed") {
          if (mode === "allowed") {
            expect(outcome).toEqual({ result: { suppressed: false } });
          }
          expect(visible).toEqual([blockerText, noticeText]);
          expect(requests).toEqual([blockerText, noticeText]);
        } else {
          if (!productionPredicate) {
            expect(outcome.error).toBeDefined();
          }
          expect(visible).toEqual([blockerText]);
          expect(requests).toEqual([blockerText]);
        }
      } finally {
        if (held && !held.writableEnded) {
          accept(held, blockerText);
        }
        await Promise.allSettled([blocker, ...(notice ? [notice] : [])]);
        runtime.close();
        restoreActivePluginRegistrySnapshot(snapshot);
        for (const socket of sockets) {
          socket.destroy();
        }
        await new Promise<void>((resolve) => {
          server.close(() => resolve());
        });
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
      const requests: Array<{
        action?: string;
        chat_id?: string | number;
        message_thread_id?: number;
      }> = [];
      const sockets = new Set<Socket>();
      const server = createServer((request, response) => {
        const chunks: Buffer[] = [];
        request.on("data", (chunk: Buffer) => chunks.push(chunk));
        request.on("end", () => {
          const payload = JSON.parse(Buffer.concat(chunks).toString("utf8"));
          requests.push(payload);
          if (requests.length === 1) {
            blocked.resolve(response);
          } else {
            response.setHeader("content-type", "application/json");
            response.end(JSON.stringify({ ok: true, result: true }));
          }
        });
      });
      server.on("connection", (socket) => {
        sockets.add(socket);
        socket.on("close", () => sockets.delete(socket));
      });
      await new Promise<void>((resolve) => {
        server.listen(0, "127.0.0.1", resolve);
      });
      const cfg: OpenClawConfig = {
        agents: { defaults: { timeoutSeconds: 30 } },
        channels: {
          telegram: {
            botToken: "123:typing-" + state.stateDir.split("/").at(-1),
            apiRoot: "http://127.0.0.1:" + (server.address() as AddressInfo).port,
          },
        },
      };
      let currentCfg = cfg;
      const scope = {
        storePath: path.join(state.stateDir, "sessions.json"),
        sessionKey: "agent:main:telegram:group:-100123:topic:99",
        sessionId: "typing-session",
        recoveryRunId: "typing-run",
        lifecycleGeneration: getAgentEventLifecycleGeneration(),
        deliveryContext: { channel: "telegram", to: "-100123", accountId: "default", threadId: 99 },
      };
      await replaceSessionEntry(
        { storePath: scope.storePath, sessionKey: scope.sessionKey },
        {
          sessionId: scope.sessionId,
          updatedAt: Date.now(),
          status: "running",
          restartRecoveryDeliveryRunId: scope.recoveryRunId,
          restartRecoveryDeliveryContext: scope.deliveryContext,
        },
      );
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
      const snapshot = captureActivePluginRegistrySnapshot();
      stageActivePluginRegistry(
        createTestRegistry([
          {
            pluginId: "telegram",
            source: "test",
            plugin: {
              ...telegramPlugin,
              heartbeat: { ...telegramPlugin.heartbeat, sendTypingGuarded: trackedTyping },
            },
          },
        ]),
        null,
        "default",
      );
      const runtime = createGatewayInstanceRuntime({
        getContext: () =>
          ({ deps: {}, getRuntimeConfig: () => currentCfg }) as GatewayRequestContext,
        getMethodRegistry: () => {
          throw new Error("Typing must not use RPC");
        },
        isDispatchAvailable: () => true,
      });
      const predecessor = Promise.resolve(
        originalTyping({ cfg, to: "-100123", accountId: "default", threadId: 1 }),
      );
      let held: ServerResponse | undefined;
      let stop: (() => void) | undefined;
      try {
        held = await Promise.race([
          blocked.promise,
          predecessor.then(() => {
            throw new Error("Predecessor did not enter HTTP");
          }),
        ]);
        stop = runtime.recovery.startRecoveryTyping?.({
          ...scope.deliveryContext,
          runId: scope.recoveryRunId,
          isCurrent: (latest) => isRestartRecoveryDeliveryCurrent({ ...scope, cfg: latest }),
        });
        await started.promise;
        await new Promise<void>((resolve) => {
          setImmediate(resolve);
        });
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
            { sessionId: "replacement-session", updatedAt: Date.now(), status: "running" },
          );
        }
        if (mode === "runtime policy revoked") {
          currentCfg = { ...cfg, session: { sendPolicy: { default: "deny" } } };
        }
        if (mode === "typing disabled") {
          currentCfg = {
            ...cfg,
            agents: { defaults: { timeoutSeconds: 30, typingMode: "never" } },
          };
        }
        held.setHeader("content-type", "application/json");
        held.end(JSON.stringify({ ok: true, result: true }));
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
          held.setHeader("content-type", "application/json");
          held.end(JSON.stringify({ ok: true, result: true }));
        }
        await predecessor.catch(() => {});
        stop?.();
        runtime.close();
        restoreActivePluginRegistrySnapshot(snapshot);
        for (const socket of sockets) {
          socket.destroy();
        }
        await new Promise<void>((resolve) => {
          server.close(() => resolve());
        });
      }
    });
  });
});
