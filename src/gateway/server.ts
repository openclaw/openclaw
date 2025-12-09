import { randomUUID } from "node:crypto";
import os from "node:os";
import { type WebSocket, WebSocketServer } from "ws";
import { GatewayLockError, acquireGatewayLock } from "../infra/gateway-lock.js";
import { createDefaultDeps } from "../cli/deps.js";
import { agentCommand } from "../commands/agent.js";
import { getHealthSnapshot } from "../commands/health.js";
import { getStatusSummary } from "../commands/status.js";
import { loadConfig } from "../config/config.js";
import { isVerbose } from "../globals.js";
import { onAgentEvent } from "../infra/agent-events.js";
import { enqueueSystemEvent } from "../infra/system-events.js";
import {
  listSystemPresence,
  upsertPresence,
} from "../infra/system-presence.js";
import { logDebug, logError } from "../logger.js";
import { getResolvedLoggerSettings } from "../logging.js";
import { monitorWebProvider, webAuthExists } from "../providers/web/index.js";
import { defaultRuntime } from "../runtime.js";
import { monitorTelegramProvider } from "../telegram/monitor.js";
import { sendMessageTelegram } from "../telegram/send.js";
import { sendMessageWhatsApp } from "../web/outbound.js";
import {
  ErrorCodes,
  type ErrorShape,
  errorShape,
  formatValidationErrors,
  type Hello,
  PROTOCOL_VERSION,
  type RequestFrame,
  type Snapshot,
  validateAgentParams,
  validateHello,
  validateRequestFrame,
  validateSendParams,
} from "./protocol/index.js";

type Client = {
  socket: WebSocket;
  hello: Hello;
  connId: string;
};

const METHODS = [
  "health",
  "status",
  "system-presence",
  "system-event",
  "send",
  "agent",
];

const EVENTS = ["agent", "presence", "tick", "shutdown"];

export type GatewayServer = {
  close: () => Promise<void>;
};

let presenceVersion = 1;
let healthVersion = 1;
let seq = 0;
// Track per-run sequence to detect out-of-order/lost agent events.
const agentRunSeq = new Map<string, number>();

function buildSnapshot(): Snapshot {
  const presence = listSystemPresence();
  const uptimeMs = Math.round(process.uptime() * 1000);
  // Health is async; caller should await getHealthSnapshot and replace later if needed.
  const emptyHealth: unknown = {};
  return {
    presence,
    health: emptyHealth,
    stateVersion: { presence: presenceVersion, health: healthVersion },
    uptimeMs,
  };
}

const MAX_PAYLOAD_BYTES = 512 * 1024; // cap incoming frame size
const MAX_BUFFERED_BYTES = 1.5 * 1024 * 1024; // per-connection send buffer limit
const HANDSHAKE_TIMEOUT_MS = 3000;
const TICK_INTERVAL_MS = 30_000;
const DEDUPE_TTL_MS = 5 * 60_000;
const DEDUPE_MAX = 1000;
const LOG_VALUE_LIMIT = 240;

type DedupeEntry = {
  ts: number;
  ok: boolean;
  payload?: unknown;
  error?: ErrorShape;
};
const dedupe = new Map<string, DedupeEntry>();

const getGatewayToken = () => process.env.CLAWDIS_GATEWAY_TOKEN;

function formatForLog(value: unknown): string {
  try {
    const str =
      typeof value === "string" || typeof value === "number"
        ? String(value)
        : JSON.stringify(value);
    if (!str) return "";
    return str.length > LOG_VALUE_LIMIT ? `${str.slice(0, LOG_VALUE_LIMIT)}...` : str;
  } catch {
    return String(value);
  }
}

function logWs(
  direction: "in" | "out",
  kind: string,
  meta?: Record<string, unknown>,
) {
  if (!isVerbose()) return;
  const parts = [`gateway/ws ${direction} ${kind}`];
  if (meta) {
    for (const [key, raw] of Object.entries(meta)) {
      if (raw === undefined) continue;
      parts.push(`${key}=${formatForLog(raw)}`);
    }
  }
  logDebug(parts.join(" "));
}

function formatError(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === "string") return err;
  const status = (err as { status?: unknown })?.status;
  const code = (err as { code?: unknown })?.code;
  if (status || code) return `status=${status ?? "unknown"} code=${code ?? "unknown"}`;
  return JSON.stringify(err, null, 2);
}

export async function startGatewayServer(port = 18789): Promise<GatewayServer> {
  const releaseLock = await acquireGatewayLock().catch((err) => {
    // Bubble known lock errors so callers can present a nice message.
    if (err instanceof GatewayLockError) throw err;
    throw new GatewayLockError(String(err));
  });

  const wss = new WebSocketServer({
    port,
    host: "127.0.0.1",
    maxPayload: MAX_PAYLOAD_BYTES,
  });
  const providerAbort = new AbortController();
  const providerTasks: Array<Promise<unknown>> = [];
  const clients = new Set<Client>();

  const startProviders = async () => {
    const cfg = loadConfig();
    const telegramToken =
      process.env.TELEGRAM_BOT_TOKEN ?? cfg.telegram?.botToken ?? "";

    if (await webAuthExists()) {
      defaultRuntime.log("gateway: starting WhatsApp Web provider");
      providerTasks.push(
        monitorWebProvider(
          isVerbose(),
          undefined,
          true,
          undefined,
          defaultRuntime,
          providerAbort.signal,
        ).catch((err) => logError(`web provider exited: ${formatError(err)}`)),
      );
    } else {
      defaultRuntime.log(
        "gateway: skipping WhatsApp Web provider (no linked session)",
      );
    }

    if (telegramToken.trim().length > 0) {
      defaultRuntime.log("gateway: starting Telegram provider");
      providerTasks.push(
        monitorTelegramProvider({
          token: telegramToken.trim(),
          runtime: defaultRuntime,
          abortSignal: providerAbort.signal,
          useWebhook: Boolean(cfg.telegram?.webhookUrl),
          webhookUrl: cfg.telegram?.webhookUrl,
          webhookSecret: cfg.telegram?.webhookSecret,
          webhookPath: cfg.telegram?.webhookPath,
        }).catch((err) =>
          logError(`telegram provider exited: ${formatError(err)}`),
        ),
      );
    } else {
      defaultRuntime.log(
        "gateway: skipping Telegram provider (no TELEGRAM_BOT_TOKEN/config)",
      );
    }
  };

  const broadcast = (
    event: string,
    payload: unknown,
    opts?: {
      dropIfSlow?: boolean;
      stateVersion?: { presence?: number; health?: number };
    },
  ) => {
    const eventSeq = ++seq;
    const frame = JSON.stringify({
      type: "event",
      event,
      payload,
      seq: eventSeq,
      stateVersion: opts?.stateVersion,
    });
    logWs("out", "event", {
      event,
      seq: eventSeq,
      clients: clients.size,
      dropIfSlow: opts?.dropIfSlow,
      presenceVersion: opts?.stateVersion?.presence,
      healthVersion: opts?.stateVersion?.health,
    });
    for (const c of clients) {
      const slow = c.socket.bufferedAmount > MAX_BUFFERED_BYTES;
      if (slow && opts?.dropIfSlow) continue;
      if (slow) {
        try {
          c.socket.close(1008, "slow consumer");
        } catch {
          /* ignore */
        }
        continue;
      }
      try {
        c.socket.send(frame);
      } catch {
        /* ignore */
      }
    }
  };

  // periodic keepalive
  const tickInterval = setInterval(() => {
    broadcast("tick", { ts: Date.now() }, { dropIfSlow: true });
  }, TICK_INTERVAL_MS);

  // dedupe cache cleanup
  const dedupeCleanup = setInterval(() => {
    const now = Date.now();
    for (const [k, v] of dedupe) {
      if (now - v.ts > DEDUPE_TTL_MS) dedupe.delete(k);
    }
    if (dedupe.size > DEDUPE_MAX) {
      const entries = [...dedupe.entries()].sort((a, b) => a[1].ts - b[1].ts);
      for (let i = 0; i < dedupe.size - DEDUPE_MAX; i++) {
        dedupe.delete(entries[i][0]);
      }
    }
  }, 60_000);

  const agentUnsub = onAgentEvent((evt) => {
    const last = agentRunSeq.get(evt.runId) ?? 0;
    if (evt.seq !== last + 1) {
      // Fan out an error event so clients can refresh the stream on gaps.
      broadcast("agent", {
        runId: evt.runId,
        stream: "error",
        ts: Date.now(),
        data: {
          reason: "seq gap",
          expected: last + 1,
          received: evt.seq,
        },
      });
    }
    agentRunSeq.set(evt.runId, evt.seq);
    broadcast("agent", evt);
  });

  wss.on("connection", (socket) => {
    let client: Client | null = null;
    let closed = false;
    const connId = randomUUID();
    const deps = createDefaultDeps();
    const remoteAddr = (
      socket as WebSocket & { _socket?: { remoteAddress?: string } }
    )._socket?.remoteAddress;
    logWs("in", "connect", { connId, remoteAddr });

    const send = (obj: unknown) => {
      try {
        socket.send(JSON.stringify(obj));
      } catch {
        /* ignore */
      }
    };

    const close = () => {
      if (closed) return;
      closed = true;
      clearTimeout(handshakeTimer);
      if (client) clients.delete(client);
      try {
        socket.close(1000);
      } catch {
        /* ignore */
      }
    };

    socket.once("error", () => close());
    socket.once("close", () => {
      if (client) {
        // mark presence as disconnected
        const key = client.hello.client.instanceId || connId;
        upsertPresence(key, {
          reason: "disconnect",
        });
        presenceVersion += 1;
        broadcast(
          "presence",
          { presence: listSystemPresence() },
          {
            dropIfSlow: true,
            stateVersion: { presence: presenceVersion, health: healthVersion },
          },
        );
      }
      logWs("out", "close", { connId });
      close();
    });

    const handshakeTimer = setTimeout(() => {
      if (!client) close();
    }, HANDSHAKE_TIMEOUT_MS);

    socket.on("message", async (data) => {
      if (closed) return;
      const text = data.toString();
      try {
        const parsed = JSON.parse(text);
        if (!client) {
          // Expect hello
          if (!validateHello(parsed)) {
            send({
              type: "hello-error",
              reason: `invalid hello: ${formatValidationErrors(validateHello.errors)}`,
            });
            socket.close(1008, "invalid hello");
            close();
            return;
          }
          const hello = parsed as Hello;
          // protocol negotiation
          const { minProtocol, maxProtocol } = hello;
          if (
            maxProtocol < PROTOCOL_VERSION ||
            minProtocol > PROTOCOL_VERSION
          ) {
            logWs("out", "hello-error", {
              connId,
              reason: "protocol mismatch",
              minProtocol,
              maxProtocol,
              expected: PROTOCOL_VERSION,
            });
            send({
              type: "hello-error",
              reason: "protocol mismatch",
              expectedProtocol: PROTOCOL_VERSION,
            });
            socket.close(1002, "protocol mismatch");
            close();
            return;
          }
          // token auth if required
          const token = getGatewayToken();
          if (token && hello.auth?.token !== token) {
            logWs("out", "hello-error", { connId, reason: "unauthorized" });
            send({
              type: "hello-error",
              reason: "unauthorized",
            });
            socket.close(1008, "unauthorized");
            close();
            return;
          }

          // synthesize presence entry for this connection (client fingerprint)
          const presenceKey = hello.client.instanceId || connId;
          logWs("in", "hello", {
            connId,
            client: hello.client.name,
            version: hello.client.version,
            mode: hello.client.mode,
            instanceId: hello.client.instanceId,
            platform: hello.client.platform,
            token: hello.auth?.token ? "set" : "none",
          });
          upsertPresence(presenceKey, {
            host: hello.client.name || os.hostname(),
            ip: remoteAddr,
            version: hello.client.version,
            mode: hello.client.mode,
            instanceId: hello.client.instanceId,
            reason: "connect",
          });
          presenceVersion += 1;
          const snapshot = buildSnapshot();
          // Fill health asynchronously for snapshot
          const health = await getHealthSnapshot();
          snapshot.health = health;
          snapshot.stateVersion.health = ++healthVersion;
          const helloOk = {
            type: "hello-ok",
            protocol: PROTOCOL_VERSION,
            server: {
              version:
                process.env.CLAWDIS_VERSION ??
                process.env.npm_package_version ??
                "dev",
              commit: process.env.GIT_COMMIT,
              host: os.hostname(),
              connId,
            },
            features: { methods: METHODS, events: EVENTS },
            snapshot,
            policy: {
              maxPayload: MAX_PAYLOAD_BYTES,
              maxBufferedBytes: MAX_BUFFERED_BYTES,
              tickIntervalMs: TICK_INTERVAL_MS,
            },
          };
          clearTimeout(handshakeTimer);
          // Add the client only after the hello response is ready so no tick/presence
          // events reach it before the handshake completes.
          client = { socket, hello, connId };
          logWs("out", "hello-ok", {
            connId,
            methods: METHODS.length,
            events: EVENTS.length,
            presence: snapshot.presence.length,
            stateVersion: snapshot.stateVersion.presence,
          });
          send(helloOk);
          clients.add(client);
          return;
        }

        // After handshake, accept only req frames
        if (!validateRequestFrame(parsed)) {
          send({
            type: "res",
            id: (parsed as { id?: unknown })?.id ?? "invalid",
            ok: false,
            error: errorShape(
              ErrorCodes.INVALID_REQUEST,
              `invalid request frame: ${formatValidationErrors(validateRequestFrame.errors)}`,
            ),
          });
          return;
        }
        const req = parsed as RequestFrame;
        logWs("in", "req", {
          connId,
          id: req.id,
          method: req.method,
        });
        const respond = (
          ok: boolean,
          payload?: unknown,
          error?: ErrorShape,
          meta?: Record<string, unknown>,
        ) => {
          send({ type: "res", id: req.id, ok, payload, error });
          logWs("out", "res", {
            connId,
            id: req.id,
            ok,
            method: req.method,
            ...meta,
          });
        };

        switch (req.method) {
          case "health": {
            const health = await getHealthSnapshot();
            healthVersion += 1;
            respond(true, health, undefined);
            break;
          }
          case "status": {
            const status = await getStatusSummary();
            respond(true, status, undefined);
            break;
          }
          case "system-presence": {
            const presence = listSystemPresence();
            respond(true, presence, undefined);
            break;
          }
          case "system-event": {
            const text = String(
              (req.params as { text?: unknown } | undefined)?.text ?? "",
            ).trim();
            if (!text) {
              respond(
                false,
                undefined,
                errorShape(ErrorCodes.INVALID_REQUEST, "text required"),
              );
              break;
            }
            enqueueSystemEvent(text);
            presenceVersion += 1;
            broadcast(
              "presence",
              { presence: listSystemPresence() },
              {
                dropIfSlow: true,
                stateVersion: {
                  presence: presenceVersion,
                  health: healthVersion,
                },
              },
            );
            respond(true, { ok: true }, undefined);
            break;
          }
          case "send": {
            const p = (req.params ?? {}) as Record<string, unknown>;
            if (!validateSendParams(p)) {
              respond(
                false,
                undefined,
                errorShape(
                  ErrorCodes.INVALID_REQUEST,
                  `invalid send params: ${formatValidationErrors(validateSendParams.errors)}`,
                ),
              );
              break;
            }
            const params = p as {
              to: string;
              message: string;
              mediaUrl?: string;
              provider?: string;
              idempotencyKey: string;
            };
            const idem = params.idempotencyKey;
            const cached = dedupe.get(`send:${idem}`);
            if (cached) {
              respond(cached.ok, cached.payload, cached.error, {
                cached: true,
              });
              break;
            }
            const to = params.to.trim();
            const message = params.message.trim();
            const provider = (params.provider ?? "whatsapp").toLowerCase();
            try {
              if (provider === "telegram") {
                const result = await sendMessageTelegram(to, message, {
                  mediaUrl: params.mediaUrl,
                  verbose: isVerbose(),
                });
                const payload = {
                  runId: idem,
                  messageId: result.messageId,
                  chatId: result.chatId,
                  provider,
                };
                dedupe.set(`send:${idem}`, {
                  ts: Date.now(),
                  ok: true,
                  payload,
                });
                respond(true, payload, undefined, { provider });
              } else {
                const result = await sendMessageWhatsApp(to, message, {
                  mediaUrl: params.mediaUrl,
                  verbose: isVerbose(),
                });
                const payload = {
                  runId: idem,
                  messageId: result.messageId,
                  toJid: result.toJid ?? `${to}@s.whatsapp.net`,
                  provider,
                };
                dedupe.set(`send:${idem}`, {
                  ts: Date.now(),
                  ok: true,
                  payload,
                });
                respond(true, payload, undefined, { provider });
              }
            } catch (err) {
              const error = errorShape(ErrorCodes.UNAVAILABLE, String(err));
              dedupe.set(`send:${idem}`, { ts: Date.now(), ok: false, error });
              respond(false, undefined, error, {
                provider,
                error: formatForLog(err),
              });
            }
            break;
          }
          case "agent": {
            const p = (req.params ?? {}) as Record<string, unknown>;
            if (!validateAgentParams(p)) {
              respond(
                false,
                undefined,
                errorShape(
                  ErrorCodes.INVALID_REQUEST,
                  `invalid agent params: ${formatValidationErrors(validateAgentParams.errors)}`,
                ),
              );
              break;
            }
            const params = p as {
              message: string;
              to?: string;
              sessionId?: string;
              thinking?: string;
              deliver?: boolean;
              idempotencyKey: string;
              timeout?: number;
            };
            const idem = params.idempotencyKey;
            const cached = dedupe.get(`agent:${idem}`);
            if (cached) {
              respond(cached.ok, cached.payload, cached.error, { cached: true });
              break;
            }
            const message = params.message.trim();
            const runId = params.sessionId || randomUUID();
            // Acknowledge via event to avoid double res frames
            const ackEvent = {
              type: "event",
              event: "agent",
              payload: { runId, status: "accepted" as const },
              seq: ++seq,
            };
            socket.send(JSON.stringify(ackEvent));
            logWs("out", "event", {
              connId,
              event: "agent",
              runId,
              status: "accepted",
            });
            try {
              await agentCommand(
                {
                  message,
                  to: params.to,
                  sessionId: params.sessionId,
                  thinking: params.thinking,
                  deliver: params.deliver,
                  timeout: params.timeout?.toString(),
                },
                defaultRuntime,
                deps,
              );
              const payload = {
                runId,
                status: "ok" as const,
                summary: "completed",
              };
              dedupe.set(`agent:${idem}`, {
                ts: Date.now(),
                ok: true,
                payload,
              });
              respond(true, payload, undefined, { runId });
            } catch (err) {
              const error = errorShape(ErrorCodes.UNAVAILABLE, String(err));
              const payload = {
                runId,
                status: "error" as const,
                summary: String(err),
              };
              dedupe.set(`agent:${idem}`, {
                ts: Date.now(),
                ok: false,
                payload,
                error,
              });
              respond(false, payload, error, {
                runId,
                error: formatForLog(err),
              });
            }
            break;
          }
          default: {
            respond(
              false,
              undefined,
              errorShape(
                ErrorCodes.INVALID_REQUEST,
                `unknown method: ${req.method}`,
              ),
            );
            break;
          }
        }
      } catch (err) {
        logError(`gateway: parse/handle error: ${String(err)}`);
        logWs("out", "parse-error", { connId, error: formatForLog(err) });
        // If still in handshake, close; otherwise respond error
        if (!client) {
          close();
        }
      }
    });
  });

  defaultRuntime.log(
    `gateway listening on ws://127.0.0.1:${port} (PID ${process.pid})`,
  );
  defaultRuntime.log(`gateway log file: ${getResolvedLoggerSettings().file}`);

  // Launch configured providers (WhatsApp Web, Telegram) so gateway replies via the
  // surface the message came from. Tests can opt out via CLAWDIS_SKIP_PROVIDERS.
  if (process.env.CLAWDIS_SKIP_PROVIDERS !== "1") {
    void startProviders();
  } else {
    defaultRuntime.log(
      "gateway: skipping provider start (CLAWDIS_SKIP_PROVIDERS=1)",
    );
  }

  return {
    close: async () => {
      await releaseLock();
      providerAbort.abort();
      broadcast("shutdown", {
        reason: "gateway stopping",
        restartExpectedMs: null,
      });
      clearInterval(tickInterval);
      clearInterval(dedupeCleanup);
      if (agentUnsub) {
        try {
          agentUnsub();
        } catch {
          /* ignore */
        }
      }
      for (const c of clients) {
        try {
          c.socket.close(1012, "service restart");
        } catch {
          /* ignore */
        }
      }
      clients.clear();
      await Promise.allSettled(providerTasks);
      await new Promise<void>((resolve) => wss.close(() => resolve()));
    },
  };
}
