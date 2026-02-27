/**
 * TGCC Supervisor integration — singleton client and event handlers.
 *
 * Started on gateway startup, stopped on shutdown.
 */

import crypto from "node:crypto";
import { execSync } from "node:child_process";
import { loadConfig } from "../../config/config.js";
import { callGateway } from "../../gateway/call.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import {
  findSubagentRunByChildSessionKey,

  markExternalSubagentRunComplete,
} from "../subagent-registry.js";
import { runSubagentAnnounceFlow } from "../subagent-announce.js";
import type { SubagentRunRecord } from "../subagent-registry.types.js";
import {
  TgccSupervisorClient,
  type TgccResultEvent,
  type TgccProcessExitEvent,
  type TgccSessionTakeoverEvent,
  type TgccApiErrorEvent,
  type TgccSupervisorClientConfig,
  type TgccAgentStatus,
  type TgccStatusResult,
} from "./client.js";

export type { TgccAgentStatus, TgccStatusResult } from "./client.js";

const log = createSubsystemLogger("tgcc-supervisor");

let client: TgccSupervisorClient | null = null;

// ---------------------------------------------------------------------------
// Public accessors
// ---------------------------------------------------------------------------

/** Get the active supervisor client (null if not configured or stopped). */
export function getTgccSupervisorClient(): TgccSupervisorClient | null {
  return client;
}

/** Check if the supervisor client is connected. */
export function isTgccSupervisorConnected(): boolean {
  return client?.isConnected() === true;
}

// ---------------------------------------------------------------------------
// Health status
// ---------------------------------------------------------------------------

export interface TgccHealthStatus {
  configured: boolean;
  connected: boolean;
  agentCount?: number;
  socketPath?: string;
  reconnecting?: boolean;
}

/** Build a health-status snapshot for status tools and heartbeat checks. */
export function getTgccHealthStatus(): TgccHealthStatus {
  const cfg = loadConfig();
  const tgccCfg = cfg.agents?.defaults?.subagents?.claudeCode?.tgccSupervisor;
  if (!tgccCfg?.socket) {
    return { configured: false, connected: false };
  }

  const connected = isTgccSupervisorConnected();
  const agentNames = Object.keys(agentCache);
  return {
    configured: true,
    connected,
    socketPath: tgccCfg.socket,
    agentCount: agentNames.length || undefined,
    reconnecting: !connected && client != null,
  };
}

// ---------------------------------------------------------------------------
// Live agent cache (source of truth: TGCC status command)
// ---------------------------------------------------------------------------

export interface TgccAgentMapping {
  description?: string;
  repo: string;
  type?: "persistent" | "ephemeral";
  state?: "idle" | "active";
}

/** Cached agent list from TGCC. Refreshed on connect and periodically. */
let agentCache: Record<string, TgccAgentMapping> = {};
let agentCacheUpdatedAt = 0;
const AGENT_CACHE_TTL_MS = 60_000; // refresh every 60s max

/** Refresh the agent cache from TGCC status. */
async function refreshAgentCache(): Promise<void> {
  if (!client?.isConnected()) {return;}
  try {
    const result = await client.getStatus();
    const fresh: Record<string, TgccAgentMapping> = {};
    for (const agent of result.agents) {
      fresh[agent.id] = {
        repo: agent.repo,
        type: agent.type,
        state: agent.state,
      };
    }
    agentCache = fresh;
    agentCacheUpdatedAt = Date.now();
    log.info(`agent cache refreshed: ${result.agents.map((a) => a.id).join(", ")}`);
  } catch (err) {
    log.warn(`failed to refresh agent cache: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/** Get live TGCC agent mappings. Returns cached data, refreshes in background if stale. */
export function getTgccAgentMappings(): Record<string, TgccAgentMapping> {
  // Trigger background refresh if stale
  if (Date.now() - agentCacheUpdatedAt > AGENT_CACHE_TTL_MS) {
    void refreshAgentCache();
  }
  return agentCache;
}

/** Check if a target name matches a known TGCC agent. */
export function isTgccAgent(target: string): boolean {
  return target in agentCache;
}

/** Build a tgcc: child session key. Keyed by agentId only — TGCC owns session state. */
export function buildTgccChildSessionKey(agentId: string): string {
  return `tgcc:${agentId}`;
}

// ---------------------------------------------------------------------------
// Auto-start via systemd
// ---------------------------------------------------------------------------

let autoStartAttempted = false;

/**
 * Attempt to start the TGCC service via systemd if autoStart is configured.
 * Only runs once — subsequent reconnect failures skip this.
 */
function attemptAutoStart(tgccCfg: {
  autoStart?: boolean;
  serviceName?: string;
  [key: string]: unknown;
}): void {
  if (autoStartAttempted) {return;}
  if (!tgccCfg.autoStart) {return;}
  autoStartAttempted = true;

  const service = tgccCfg.serviceName ?? "tgcc";

  try {
    const result = execSync(`systemctl --user is-active ${service}.service 2>/dev/null`, {
      encoding: "utf-8",
      timeout: 5_000,
    }).trim();

    if (result === "active") {
      log.info(`TGCC service ${service}.service is already active, socket may not be ready yet`);
      return;
    }
  } catch {
    // is-active returns non-zero for inactive/failed — expected
  }

  log.info(`TGCC auto-start: starting ${service}.service via systemd`);

  try {
    execSync(`systemctl --user start ${service}.service`, {
      encoding: "utf-8",
      timeout: 10_000,
    });
    log.info(`TGCC auto-start: ${service}.service started successfully`);
  } catch (err) {
    log.warn(
      `TGCC auto-start: failed to start ${service}.service: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  // Check if the service is enabled (boot persistence)
  try {
    const enabled = execSync(`systemctl --user is-enabled ${service}.service 2>/dev/null`, {
      encoding: "utf-8",
      timeout: 5_000,
    }).trim();

    if (enabled !== "enabled") {
      log.info(
        `TGCC service ${service}.service is not enabled for boot. ` +
          `Run: systemctl --user enable ${service}`,
      );
    }
  } catch {
    log.info(
      `TGCC service ${service}.service may not be enabled for boot. ` +
        `Run: systemctl --user enable ${service}`,
    );
  }
}

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

/** Start the supervisor client if configured. Called on gateway startup. */
export function startTgccSupervisor(): void {
  if (client) {
    log.info("TGCC supervisor client already running");
    return;
  }

  const cfg = loadConfig();
  const tgccCfg = cfg.agents?.defaults?.subagents?.claudeCode?.tgccSupervisor;
  if (!tgccCfg?.socket) {
    log.info("TGCC supervisor not configured (no socket path)");
    return;
  }

  const clientConfig: TgccSupervisorClientConfig = {
    socket: tgccCfg.socket,
    reconnectInitialMs: tgccCfg.reconnectInitialMs,
    reconnectMaxMs: tgccCfg.reconnectMaxMs,
    heartbeatMs: tgccCfg.heartbeatMs,
  };

  client = new TgccSupervisorClient(clientConfig);
  attachEventHandlers(client);

  // On first connection failure, attempt systemd auto-start
  client.on("connectFailed", () => {
    attemptAutoStart(tgccCfg);
  });

  client.start();
  log.info(`TGCC supervisor client started (socket: ${tgccCfg.socket})`);
}

/** Stop the supervisor client. Called on gateway shutdown. */
export function stopTgccSupervisor(): void {
  if (!client) {return;}
  client.stop();
  client = null;
  agentCache = {};
  agentCacheUpdatedAt = 0;
  log.info("TGCC supervisor client stopped");
}

// ---------------------------------------------------------------------------
// Event handlers
// ---------------------------------------------------------------------------

function attachEventHandlers(c: TgccSupervisorClient): void {
  c.on("connected", () => void refreshAgentCache());
  c.on("tgcc:result", handleResult);
  c.on("tgcc:process_exit", handleProcessExit);
  c.on("tgcc:session_takeover", handleSessionTakeover);
  c.on("tgcc:api_error", handleApiError);

  // Phase 2: lifecycle events
  c.on("tgcc:bridge_started", () => void refreshAgentCache());
  c.on("tgcc:cc_spawned", handleCcSpawned);
  c.on("tgcc:agent_created", handleAgentCreated);
  c.on("tgcc:agent_destroyed", handleAgentDestroyed);
  c.on("tgcc:state_changed", handleStateChanged);

  // Phase 2: high-signal observability events → inject into requester session
  c.on("tgcc:build_result", handleObservabilityEvent);
  c.on("tgcc:git_commit", handleObservabilityEvent);
  c.on("tgcc:context_pressure", handleObservabilityEvent);
  c.on("tgcc:failure_loop", handleObservabilityEvent);
  c.on("tgcc:stuck", handleObservabilityEvent);
  c.on("tgcc:task_milestone", handleObservabilityEvent);
  c.on("tgcc:cc_message", handleObservabilityEvent);
  c.on("tgcc:subagent_spawn", handleObservabilityEvent);
  c.on("tgcc:budget_alert", handleObservabilityEvent);

  // Phase 3: reverse notify
  c.on("tgcc:reverse_notify", handleReverseNotify);
}

/** Find the active subagent run for a TGCC agent. Keyed by agentId only. */
function findTgccRun(agentId: string): SubagentRunRecord | null {
  const childKey = buildTgccChildSessionKey(agentId);
  return findSubagentRunByChildSessionKey(childKey);
}

function handleResult(event: TgccResultEvent): void {
  log.info(
    `result from ${event.agentId} (${event.is_error ? "error" : "ok"}, cost=$${event.cost_usd?.toFixed(4) ?? "?"})`,
  );

  const run = findTgccRun(event.agentId);
  if (!run) {
    log.info(`no subagent run found for tgcc:${event.agentId}, ignoring result`);
    return;
  }

  const now = Date.now();
  markExternalSubagentRunComplete({
    runId: run.runId,
    outcome: event.is_error ? { status: "error", error: event.text } : { status: "ok" },
    endedAt: now,
  });

  // Announce result back to the requester session
  const cfg = loadConfig();
  const timeoutMs = cfg.agents?.defaults?.subagents?.announceTimeoutMs ?? 30_000;
  void runSubagentAnnounceFlow({
    childSessionKey: run.childSessionKey,
    childRunId: run.runId,
    requesterSessionKey: run.requesterSessionKey,
    requesterDisplayKey: run.requesterSessionKey,
    task: run.task,
    timeoutMs,
    cleanup: "keep",
    roundOneReply: event.text,
    waitForCompletion: false,
    startedAt: run.startedAt ?? run.createdAt,
    endedAt: now,
    outcome: event.is_error ? { status: "error", error: event.text } : { status: "ok" },
    label: run.label,
  }).then((announced) => {
    log.info(`announce flow for ${event.agentId}: ${announced ? "delivered" : "not delivered"}`);
  }).catch((err) => {
    log.warn(`announce flow error for ${event.agentId}: ${err instanceof Error ? err.message : String(err)}`);
  });
}

function handleProcessExit(event: TgccProcessExitEvent): void {
  log.info(`process_exit from ${event.agentId} (exit=${event.exitCode})`);

  const run = findTgccRun(event.agentId);
  if (!run) {return;}
  if (run.endedAt) {return;}

  markExternalSubagentRunComplete({
    runId: run.runId,
    outcome:
      event.exitCode === 0 ? { status: "ok" } : { status: "error", error: `exit code ${event.exitCode}` },
    endedAt: Date.now(),
  });
}

function handleSessionTakeover(event: TgccSessionTakeoverEvent): void {
  log.info(`session_takeover for ${event.agentId}`);

  const run = findTgccRun(event.agentId);
  if (!run) {return;}

  log.info(`session taken over by another client, run ${run.runId} stays active`);
}

function handleApiError(event: TgccApiErrorEvent): void {
  log.warn(`api_error from ${event.agentId}:${event.sessionId}: ${event.message}`);
  // Inject as observability notification
  const run = findTgccRun(event.agentId);
  if (run) {
    void injectObservabilityMessage(
      run,
      `[subagent:${event.agentId}] ❌ API error: ${event.message}`,
    );
  }
}

// ---------------------------------------------------------------------------
// Phase 2: Lifecycle event handlers
// ---------------------------------------------------------------------------

function handleCcSpawned(event: Record<string, unknown>): void {
  const agentId = String(event.agentId ?? "");
  const source = String(event.source ?? "unknown");
  log.info(`cc_spawned: ${agentId} (source=${source})`);
  // Update cache state
  if (agentId && agentCache[agentId]) {
    agentCache[agentId].state = "active";
  }
}

function handleAgentCreated(event: Record<string, unknown>): void {
  const agentId = String(event.agentId ?? "");
  const repo = String(event.repo ?? "");
  const agentType = String(event.type ?? "ephemeral") as "persistent" | "ephemeral";
  log.info(`agent_created: ${agentId} (type=${agentType}, repo=${repo})`);
  if (agentId) {
    agentCache[agentId] = { repo, type: agentType, state: "idle" };
    agentCacheUpdatedAt = Date.now();
  }
}

function handleAgentDestroyed(event: Record<string, unknown>): void {
  const agentId = String(event.agentId ?? "");
  log.info(`agent_destroyed: ${agentId}`);
  if (agentId) {
    delete agentCache[agentId];
    agentCacheUpdatedAt = Date.now();
  }
  // Clean up subagent run if exists
  const run = findTgccRun(agentId);
  if (run && !run.endedAt) {
    markExternalSubagentRunComplete({
      runId: run.runId,
      outcome: { status: "error", error: "agent destroyed" },
      endedAt: Date.now(),
    });
  }
}

function handleStateChanged(event: Record<string, unknown>): void {
  const agentId = String(event.agentId ?? "");
  const field = String(event.field ?? "");
  const newValue = event.newValue;
  log.info(`state_changed: ${agentId}.${field} = ${String(newValue)}`);
  if (agentId && agentCache[agentId]) {
    if (field === "state" && (newValue === "idle" || newValue === "active")) {
      agentCache[agentId].state = newValue;
    } else if (field === "repo" && typeof newValue === "string") {
      agentCache[agentId].repo = newValue;
    }
  }
}

// ---------------------------------------------------------------------------
// Phase 2: Observability event handler — inject system messages
// ---------------------------------------------------------------------------

function formatObservabilityMessage(event: Record<string, unknown>): string | null {
  const agentId = String(event.agentId ?? "unknown");
  const prefix = `[subagent:${agentId}]`;
  const eventName = String(event.event ?? "");

  switch (eventName) {
    case "build_result": {
      const passed = event.passed === true;
      if (passed) return `${prefix} 🔨 Build passed ✅`;
      const errors = typeof event.errors === "number" ? event.errors : "?";
      const summary = typeof event.summary === "string" ? `: ${event.summary}` : "";
      return `${prefix} 🔨 Build failed: ${errors} errors${summary}`;
    }
    case "git_commit": {
      const msg = typeof event.message === "string" ? event.message : "?";
      return `${prefix} 📝 Committed: "${msg}"`;
    }
    case "context_pressure": {
      const pct = typeof event.percent === "number" ? event.percent : "?";
      return `${prefix} 🧠 Context at ${pct}%`;
    }
    case "failure_loop": {
      const n = typeof event.consecutiveFailures === "number" ? event.consecutiveFailures : "?";
      return `${prefix} 🔁 ${n} consecutive failures`;
    }
    case "stuck": {
      const mins = typeof event.silentMs === "number" ? Math.round(event.silentMs / 60_000) : "?";
      return `${prefix} ⚠️ No progress for ${mins}m`;
    }
    case "task_milestone": {
      const task = typeof event.task === "string" ? event.task : "?";
      const progress = typeof event.progress === "string" ? `[${event.progress}] ` : "";
      return `${prefix} 📋 ${progress}${task} ✅`;
    }
    case "cc_message": {
      const text = typeof event.text === "string" ? event.text : "?";
      return `${prefix} 💬 "${text}"`;
    }
    case "subagent_spawn": {
      const count = typeof event.count === "number" ? event.count : "?";
      return `${prefix} 🔄 Spawned ${count} sub-agents`;
    }
    case "budget_alert": {
      const cost = typeof event.costUsd === "number" ? `$${event.costUsd.toFixed(2)}` : "$?";
      const budget = typeof event.budgetUsd === "number" ? `$${event.budgetUsd.toFixed(2)}` : "$?";
      return `${prefix} 💰 ${cost} spent (budget: ${budget})`;
    }
    default:
      return null;
  }
}

function handleObservabilityEvent(event: Record<string, unknown>): void {
  const agentId = String(event.agentId ?? "");
  const message = formatObservabilityMessage(event);
  if (!message) return;

  log.info(`observability: ${message}`);

  const run = findTgccRun(agentId);
  if (run) {
    void injectObservabilityMessage(run, message);
    return;
  }

  // No tracked subagent run — persistent agent not spawned by OpenClaw.
  // Deliver to main session. Only wake agent for cc_message (explicit notify_parent).
  const eventName = String(event.event ?? "");
  const shouldWake = eventName === "cc_message";
  const cfg = loadConfig();
  const mainKey = cfg.session?.mainKey ?? "agent:main:main";
  void callGateway({
    method: "agent",
    params: {
      sessionKey: mainKey,
      idempotencyKey: crypto.randomUUID(),
      message: `[System Event] ${message}`,
      deliver: shouldWake,
    },
    timeoutMs: 10_000,
  }).catch((err: unknown) => {
    log.warn(`observability fallback to main failed: ${err instanceof Error ? err.message : String(err)}`);
  });
}

/**
 * Inject a system-level message into the requester's session context.
 * Uses callGateway to send a user-role message that the agent will process.
 */
async function injectObservabilityMessage(
  run: SubagentRunRecord,
  message: string,
): Promise<void> {
  try {
    await callGateway({
      method: "agent",
      params: {
        sessionKey: run.requesterSessionKey,
        message: `[System Event] ${message}`,
        deliver: false,
        
      },
      timeoutMs: 10_000,
    });
  } catch (err) {
    log.warn(
      `failed to inject observability message: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

// ---------------------------------------------------------------------------
// Phase 3: Reverse notify handler
// ---------------------------------------------------------------------------

function handleReverseNotify(event: { target: string; message: string }): void {
  const { target, message } = event;
  log.info(`reverse notify to ${target}: ${message.slice(0, 200)}`);

  if (!target || !message) return;

  // Resolve target to a session key — "main" maps to the main agent session
  const cfg = loadConfig();
  const mainKey = cfg.session?.mainKey ?? "agent:main:main";
  const sessionKey = target === "main" ? mainKey : `agent:${target}:main`;

  void callGateway({
    method: "agent",
    params: {
      sessionKey,
      idempotencyKey: crypto.randomUUID(),
      message: `[TGCC Notification] ${message}`,
      deliver: true,
      
    },
    timeoutMs: 10_000,
  }).catch((err: unknown) => {
    log.warn(`reverse notify failed: ${err instanceof Error ? err.message : String(err)}`);
  });
}
