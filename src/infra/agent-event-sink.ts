import crypto from "node:crypto";
import type { AgentEventSinkConfig } from "../config/types.base.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { resolveConfiguredSecretInputString } from "../gateway/resolve-configured-secret-input-string.js";
import { fetchWithSsrFGuard } from "../plugin-sdk/ssrf-runtime.js";
import type { AgentEventPayload } from "./agent-events.js";
import { onAgentEvent } from "./agent-events.js";

const DEFAULT_TIMEOUT_MS = 5_000;

export type AgentEventSinkEvent =
  | {
      event: "thinking_start";
      runId: string;
      sessionKey?: string;
      timestamp: number;
    }
  | {
      event: "thinking_stream";
      runId: string;
      delta: string;
      timestamp: number;
    }
  | {
      event: "thinking_end";
      runId: string;
      timestamp: number;
    }
  | {
      event: "reply_start";
      runId: string;
      sessionKey?: string;
      timestamp: number;
    }
  | {
      event: "reply_stream";
      runId: string;
      delta: string;
      timestamp: number;
    }
  | {
      event: "reply_end";
      runId: string;
      timestamp: number;
    };

type RunStreamState = {
  thinkingStarted: boolean;
  replyStarted: boolean;
};

export function startAgentEventSink(params: {
  config: AgentEventSinkConfig;
  resolvedSecret?: string;
  resolvedHeaders?: Record<string, string>;
  warn?: (message: string) => void;
}): () => void {
  const { config, resolvedSecret, resolvedHeaders, warn } = params;
  const timeoutMs = config.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const runStates = new Map<string, RunStreamState>();
  let chain: Promise<void> = Promise.resolve();

  function getRunState(runId: string): RunStreamState {
    let state = runStates.get(runId);
    if (!state) {
      state = { thinkingStarted: false, replyStarted: false };
      runStates.set(runId, state);
    }
    return state;
  }

  async function post(payload: AgentEventSinkEvent): Promise<void> {
    const body = JSON.stringify(payload);
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      ...resolvedHeaders,
    };
    if (resolvedSecret) {
      const sig = crypto.createHmac("sha256", resolvedSecret).update(body).digest("hex");
      headers["X-Openclaw-Signature"] = `sha256=${sig}`;
    }
    let release: (() => Promise<void>) | undefined;
    try {
      const result = await fetchWithSsrFGuard({
        url: config.url,
        init: { method: "POST", headers, body },
        timeoutMs,
        requireHttps: true,
        capture: false,
      });
      release = result.release;
      if (!result.response.ok) {
        warn?.(
          `agent event sink: unexpected status ${result.response.status} from ${config.url}`,
        );
      }
    } catch (err: unknown) {
      warn?.(`agent event sink: POST failed: ${String(err)}`);
    } finally {
      await release?.();
    }
  }

  function enqueue(payload: AgentEventSinkEvent): void {
    chain = chain.then(() => post(payload)).catch(() => undefined);
  }

  function handleThinking(evt: AgentEventPayload): void {
    const state = getRunState(evt.runId);
    const delta =
      typeof (evt.data as { delta?: unknown }).delta === "string"
        ? (evt.data as { delta: string }).delta
        : undefined;
    if (!delta) {
      return;
    }
    if (!state.thinkingStarted) {
      state.thinkingStarted = true;
      enqueue({
        event: "thinking_start",
        runId: evt.runId,
        sessionKey: evt.sessionKey,
        timestamp: evt.ts,
      });
    }
    enqueue({
      event: "thinking_stream",
      runId: evt.runId,
      delta,
      timestamp: evt.ts,
    });
  }

  function handleAssistant(evt: AgentEventPayload): void {
    const state = getRunState(evt.runId);
    if (state.thinkingStarted) {
      state.thinkingStarted = false;
      enqueue({
        event: "thinking_end",
        runId: evt.runId,
        timestamp: evt.ts,
      });
    }
    const delta =
      typeof (evt.data as { delta?: unknown }).delta === "string"
        ? (evt.data as { delta: string }).delta
        : typeof (evt.data as { text?: unknown }).text === "string"
          ? (evt.data as { text: string }).text
          : undefined;
    if (!delta) {
      return;
    }
    if (!state.replyStarted) {
      state.replyStarted = true;
      enqueue({
        event: "reply_start",
        runId: evt.runId,
        sessionKey: evt.sessionKey,
        timestamp: evt.ts,
      });
    }
    enqueue({
      event: "reply_stream",
      runId: evt.runId,
      delta,
      timestamp: evt.ts,
    });
  }

  function handleLifecycle(evt: AgentEventPayload): void {
    const phase = (evt.data as { phase?: unknown }).phase;
    if (phase !== "end" && phase !== "error") {
      return;
    }
    const state = runStates.get(evt.runId);
    if (!state) {
      return;
    }
    if (state.thinkingStarted) {
      enqueue({
        event: "thinking_end",
        runId: evt.runId,
        timestamp: evt.ts,
      });
    }
    if (state.replyStarted) {
      enqueue({
        event: "reply_end",
        runId: evt.runId,
        timestamp: evt.ts,
      });
    }
    runStates.delete(evt.runId);
  }

  const unsubscribe = onAgentEvent((evt) => {
    switch (evt.stream) {
      case "thinking":
        handleThinking(evt);
        break;
      case "assistant":
        handleAssistant(evt);
        break;
      case "lifecycle":
        handleLifecycle(evt);
        break;
    }
  });

  warn?.(`agent event sink: listening for thinking + assistant events → ${config.url}`);

  return unsubscribe;
}

export async function maybeStartAgentEventSink(params: {
  config: OpenClawConfig;
  warn?: (message: string) => void;
}): Promise<(() => void) | undefined> {
  const sinkCfg = params.config.agentEventSink;
  if (!sinkCfg?.url) {
    return undefined;
  }
  const { warn } = params;
  let resolvedSecret: string | undefined;
  if (sinkCfg.secret) {
    const resolution = await resolveConfiguredSecretInputString({
      config: params.config,
      env: process.env,
      value: sinkCfg.secret,
      path: "agentEventSink.secret",
    });
    if (resolution.unresolvedRefReason) {
      warn?.(
        `agent event sink: secret unresolved (${resolution.unresolvedRefReason}), sink disabled`,
      );
      return undefined;
    }
    resolvedSecret = resolution.value;
  }
  let resolvedHeaders: Record<string, string> | undefined;
  if (sinkCfg.headers) {
    const resolved: Record<string, string> = {};
    for (const [key, val] of Object.entries(sinkCfg.headers)) {
      const resolution = await resolveConfiguredSecretInputString({
        config: params.config,
        env: process.env,
        value: val,
        path: `agentEventSink.headers.${key}`,
      });
      if (resolution.unresolvedRefReason) {
        warn?.(
          `agent event sink: header "${key}" unresolved (${resolution.unresolvedRefReason}), sink disabled`,
        );
        return undefined;
      }
      if (resolution.value !== undefined) {
        resolved[key] = resolution.value;
      }
    }
    resolvedHeaders = resolved;
  }
  return startAgentEventSink({
    config: sinkCfg,
    resolvedSecret,
    resolvedHeaders,
    warn,
  });
}
