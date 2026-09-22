import { EventEmitter } from "node:events";
import type { IncomingMessage } from "node:http";
import { describe, expect, it, vi } from "vitest";
import { GATEWAY_SERVER_CAPS } from "../../../packages/gateway-protocol/src/server-capabilities.js";
import { PROTOCOL_VERSION } from "../../../packages/gateway-protocol/src/version.js";
import { createDeferred } from "../../../test/helpers/promise.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import type { HealthSummary } from "../health/types.js";
import { GatewayConnectionWork } from "../server-connection-work.js";
import { GatewayClientRegistry } from "./client-registry.js";
import type { GatewayConnectionTransport } from "./connection-transport.js";
import { attachGatewayConnection } from "./connection.js";
import {
  createGatewayWsTestLogger,
  createGatewayWsTestRequestContext,
} from "./ws-connection.test-helpers.js";

describe("Gateway connection transport", () => {
  it.each(["written", "failed"] as const)(
    "owns admission and cleanup without WebSocket internals (hello %s)",
    async (delivery) => {
      await withOpenClawTestState(
        { label: "gateway-connection-transport", layout: "state-only" },
        async () => {
          const incoming = new EventEmitter();
          const frames: Array<{
            event?: string;
            ok?: boolean;
            payload?: { type?: string; capabilities?: string[] };
          }> = [];
          const clients = new GatewayClientRegistry();
          const connectionWork = new GatewayConnectionWork();
          const helloSent = createDeferred();
          const healthRefreshStarted = createDeferred();
          const transportClosed = createDeferred<Error>();
          const waitForReadiness = async (ready: Promise<void>) => {
            const error = await Promise.race([ready, transportClosed.promise]);
            if (error) {
              throw error;
            }
          };
          let readyState = 1;
          let finishHello: ((error?: Error) => void) | undefined;
          const socket: GatewayConnectionTransport = {
            get readyState() {
              return readyState;
            },
            bufferedAmount: 0,
            send: (encoded, callback) => {
              const frame = JSON.parse(encoded);
              frames.push(frame);
              if (frame.payload?.type === "hello-ok") {
                finishHello = callback;
                helloSent.resolve();
              } else {
                callback?.();
              }
            },
            close: (code = 1000, reason = "") => {
              if (readyState === 3) {
                return;
              }
              readyState = 3;
              const error = new Error("transport closed", { cause: { code, reason } });
              transportClosed.resolve(error);
              const pending = finishHello;
              finishHello = undefined;
              pending?.(error);
              incoming.emit("close", code, Buffer.from(reason));
            },
            terminate: () => socket.close(1006),
            on: incoming.on.bind(incoming),
            off: incoming.off.bind(incoming),
            once: incoming.once.bind(incoming),
          };
          const releasePreauth = vi.fn();
          const refreshHealthSnapshot = vi.fn(async (): Promise<HealthSummary> => {
            healthRefreshStarted.resolve();
            return {
              ok: true,
              ts: 1,
              durationMs: 0,
              channels: {},
              channelOrder: [],
              channelLabels: {},
              heartbeatSeconds: 0,
              agents: [],
              sessions: { path: "", count: 0, recent: [] },
            };
          });
          const activateReceive = vi.fn(() => expect(clients.size).toBe(1));
          const requestContext = {
            ...createGatewayWsTestRequestContext(),
            terminalSessions: { handleDisconnect: vi.fn() },
          };

          attachGatewayConnection({
            socket,
            connectionKind: "gateway",
            request: { headers: { host: "127.0.0.1:19001" } } as IncomingMessage,
            ingressAttribution: {
              kind: "direct-local",
              clientIp: "127.0.0.1",
              rateLimit: { subject: { key: "127.0.0.1" }, resetOnSuccess: true },
            },
            addresses: { remoteAddr: "127.0.0.1" },
            releasePreauth,
            clients,
            connectionWork,
            bootId: "transport-test-boot",
            pluginNodeCapabilities: [],
            originCheckMetrics: { hostHeaderFallbackAccepted: 0 },
            prepareAuthenticatedReceive: () => {
              expect(clients.size).toBe(0);
              return { ok: true, value: activateReceive };
            },
            getResolvedAuth: () => ({
              mode: "token",
              token: "test-token",
              allowTailscale: false,
            }),
            gatewayMethods: [],
            events: [],
            refreshHealthSnapshot,
            logGateway: createGatewayWsTestLogger() as never,
            logHealth: createGatewayWsTestLogger() as never,
            logWsControl: createGatewayWsTestLogger() as never,
            extraHandlers: {},
            broadcast: vi.fn(),
            buildRequestContext: () => requestContext as never,
          });

          try {
            expect(frames[0]).toMatchObject({
              event: "connect.challenge",
              payload: {
                capabilities: [GATEWAY_SERVER_CAPS.MODEL_CATALOG_SNAPSHOT],
              },
            });
            const connect = (id: string) =>
              Buffer.from(
                JSON.stringify({
                  type: "req",
                  id,
                  method: "connect",
                  params: {
                    minProtocol: PROTOCOL_VERSION,
                    maxProtocol: PROTOCOL_VERSION,
                    client: {
                      id: "gateway-client",
                      version: "dev",
                      platform: "test",
                      mode: "backend",
                    },
                    role: "operator",
                    scopes: [],
                    auth: { token: "test-token" },
                  },
                }),
              );

            incoming.emit("message", connect("connect-1"));
            incoming.emit("message", connect("connect-2"));
            await waitForReadiness(helloSent.promise);
            expect(finishHello).toBeTypeOf("function");
            expect(clients.size).toBe(1);
            expect(activateReceive).toHaveBeenCalledOnce();
            expect(releasePreauth).toHaveBeenCalledOnce();
            expect(frames.filter((frame) => frame.payload?.type === "hello-ok")).toHaveLength(1);
            expect(refreshHealthSnapshot).not.toHaveBeenCalled();

            const client = [...clients][0]!;
            expect(client.socket).toBe(socket);
            expect(client.webSocket).toBeUndefined();
            expect(client.connectionSignal?.aborted).toBe(false);
            requestContext.unsubscribeAllSessionEvents.mockImplementation(() => {
              expect(client.connectionSignal?.aborted).toBe(true);
            });

            const complete = finishHello!;
            finishHello = undefined;
            complete(delivery === "failed" ? new Error("write failed") : undefined);
            if (delivery === "written") {
              await waitForReadiness(healthRefreshStarted.promise);
              expect(refreshHealthSnapshot).toHaveBeenCalledOnce();
            }
            await connectionWork.drain();

            expect(clients.size).toBe(0);
            expect(client.connectionSignal?.aborted).toBe(true);
            expect(releasePreauth).toHaveBeenCalledOnce();
            expect(requestContext.unsubscribeAllSessionEvents).toHaveBeenCalledExactlyOnceWith(
              client.connId,
            );
            expect(
              requestContext.terminalSessions.handleDisconnect,
            ).toHaveBeenCalledExactlyOnceWith(client.connId);
            if (delivery === "failed") {
              expect(refreshHealthSnapshot).not.toHaveBeenCalled();
            }
          } finally {
            socket.terminate();
            await connectionWork.drain();
          }
        },
      );
    },
  );
});
