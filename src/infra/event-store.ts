/**
 * Event Store — NATS JetStream integration for OpenClaw
 * Publishes agent events for audit, replay, and multi-agent sharing.
 */

import {
  connect,
  type NatsConnection,
  type JetStreamClient,
  StringCodec,
  RetentionPolicy,
  StorageType,
  Events,
} from "nats";
import { randomUUID } from "node:crypto";
import type { AgentEventPayload } from "./agent-events.js";
import { onAgentEvent } from "./agent-events.js";

const sc = StringCodec();

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

export type EventStoreConfig = {
  enabled: boolean;
  natsUrl: string;
  streamName: string;
  subjectPrefix: string;
};

export type EventType =
  | "msg.in"
  | "msg.out"
  | "tool.call"
  | "tool.result"
  | "run.start"
  | "run.end"
  | "run.error";

export type ClawEvent = {
  id: string;
  ts: number;
  agent: string;
  session: string;
  type: EventType;
  payload: AgentEventPayload;
};

// ─────────────────────────────────────────────────────────────────────────────
// State (encapsulated)
// ─────────────────────────────────────────────────────────────────────────────

type State = {
  nc: NatsConnection;
  js: JetStreamClient;
  config: EventStoreConfig;
  unsub: () => void;
};

let state: State | null = null;

// ─────────────────────────────────────────────────────────────────────────────
// Helpers (minimal)
// ─────────────────────────────────────────────────────────────────────────────

const EVENT_TYPE_MAP: Record<string, EventType> = {
  user: "msg.in",
  assistant: "msg.out",
  tool: "tool.call",
  lifecycle: "run.start",
  error: "run.error",
};

function toEventType(stream: string, data: Record<string, unknown>): EventType {
  if (stream === "tool" && ("result" in data || "output" in data)) {
    return "tool.result";
  }
  if (stream === "lifecycle") {
    const phase = data?.phase;
    if (phase === "end") return "run.end";
    if (phase === "error") return "run.error";
    return "run.start";
  }
  return EVENT_TYPE_MAP[stream] ?? "msg.out";
}

function getAgent(sessionKey?: string): string {
  if (!sessionKey || sessionKey === "main") return "main";
  return sessionKey.split(":")[0] ?? "unknown";
}

function log(msg: string, err?: unknown): void {
  const prefix = "[event-store]";
  if (err) {
    console.error(prefix, msg, err);
  } else {
    console.log(prefix, msg);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Core
// ─────────────────────────────────────────────────────────────────────────────

async function publish(evt: AgentEventPayload): Promise<void> {
  if (!state) return;

  const event: ClawEvent = {
    id: randomUUID(),
    ts: evt.ts,
    agent: getAgent(evt.sessionKey),
    session: evt.sessionKey ?? "unknown",
    type: toEventType(evt.stream, evt.data),
    payload: evt,
  };

  const subject = `${state.config.subjectPrefix}.${event.agent}.${event.type.replace(".", "_")}`;
  await state.js.publish(subject, sc.encode(JSON.stringify(event)));
}

async function ensureStream(nc: NatsConnection, cfg: EventStoreConfig): Promise<void> {
  const jsm = await nc.jetstreamManager();
  try {
    await jsm.streams.info(cfg.streamName);
  } catch {
    await jsm.streams.add({
      name: cfg.streamName,
      subjects: [`${cfg.subjectPrefix}.>`],
      retention: RetentionPolicy.Limits,
      storage: StorageType.File,
      max_age: 0,
      num_replicas: 1,
    });
    log(`Created stream: ${cfg.streamName}`);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Public API
// ─────────────────────────────────────────────────────────────────────────────

export async function initEventStore(config: EventStoreConfig): Promise<void> {
  if (!config.enabled) {
    log("Disabled");
    return;
  }

  if (state) {
    log("Already initialized");
    return;
  }

  try {
    // Parse URL
    const url = config.natsUrl.startsWith("nats://") ? new URL(config.natsUrl) : null;

    const nc = await connect({
      servers: url ? `${url.hostname}:${url.port || 4222}` : config.natsUrl,
      user: url?.username ? decodeURIComponent(url.username) : undefined,
      pass: url?.password ? decodeURIComponent(url.password) : undefined,
      reconnect: true,
      maxReconnectAttempts: -1,
    });

    log(`Connected to ${config.natsUrl}`);

    // Reconnection handler
    (async () => {
      for await (const s of nc.status()) {
        if (s.type === Events.Reconnect) {
          log("Reconnected");
        } else if (s.type === Events.Disconnect) {
          log("Disconnected, reconnecting...");
        }
      }
    })().catch(() => {});

    const js = nc.jetstream();
    await ensureStream(nc, config);

    const unsub = onAgentEvent((evt) => {
      publish(evt).catch((e) => log("Publish failed", e));
    });

    state = { nc, js, config, unsub };
    log("Ready");
  } catch (err) {
    log("Init failed", err);
  }
}

export async function shutdownEventStore(): Promise<void> {
  if (!state) return;
  state.unsub();
  await state.nc.drain();
  state = null;
  log("Shutdown");
}

export function isEventStoreConnected(): boolean {
  return state !== null && !state.nc.isClosed();
}

export function getEventStoreStatus(): {
  connected: boolean;
  stream: string | null;
} {
  return {
    connected: isEventStoreConnected(),
    stream: state?.config.streamName ?? null,
  };
}
