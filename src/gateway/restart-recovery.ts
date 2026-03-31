import fsSync from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { getLatestSubagentRunByChildSessionKey } from "../agents/subagent-registry-read.js";
import { markSubagentRunTerminated } from "../agents/subagent-registry.js";
import type { FinalizedMsgContext } from "../auto-reply/templating.js";
import { loadConfig, type OpenClawConfig } from "../config/config.js";
import { resolveStateDir } from "../config/paths.js";
import { resolveCronStorePath } from "../cron/store.js";
import type { CronJob } from "../cron/types.js";
import { requestHeartbeatNow } from "../infra/heartbeat-wake.js";
import { enqueueSystemEvent } from "../infra/system-events.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { parseAgentSessionKey } from "../routing/session-key.js";
import {
  loadCombinedSessionStoreForGateway,
  listSessionsFromStore,
  readLastMessagePreviewFromTranscript,
} from "./session-utils.js";
import type { GatewaySessionRow } from "./session-utils.types.js";

const log = createSubsystemLogger("gateway/restart-recovery");

const DEFAULT_MANIFEST_PATH = "restart-manifest.json";
const RESTART_INTENT_FILENAME = "restart-intent.json";
const ACTIVE_SESSION_STATUS = new Set(["running"]);

export type GatewayRestartConfig = {
  sessionRecovery: boolean;
  cronRetryOnInterrupt: boolean;
  readinessGate: boolean;
  readinessGateThreshold: number;
  drainQueueMessages: boolean;
  manifestPath: string;
};

export type RestartManifestQueuedMessage = {
  sessionKey: string;
  surface?: string;
  provider?: string;
  sender?: string;
  threadId?: string | number;
  body?: string;
  bodyForAgent?: string;
  receivedAt: number;
};

export type RestartManifestSubagent = {
  sessionKey: string;
  task?: string;
  label?: string;
};

export type RestartManifestActiveSession = {
  key: string;
  status: string;
  updatedAt?: number | null;
  channel?: string;
  channelTarget?: string;
  threadId?: string | number;
  lastMessagePreview?: string;
  activeSubagents: RestartManifestSubagent[];
};

export type RestartManifestActiveCronRun = {
  jobId: string;
  jobName?: string;
  startedAt: number;
  status: "running";
};

export type RestartManifest = {
  version: 1;
  timestamp: string;
  reason?: string;
  triggeredBy?: string;
  activeSessions: RestartManifestActiveSession[];
  activeCronRuns: RestartManifestActiveCronRun[];
  queuedMessages: RestartManifestQueuedMessage[];
};

export type GatewayRestartReadiness = {
  activeSessions: RestartManifestActiveSession[];
  activeCronRuns: RestartManifestActiveCronRun[];
  totalActive: number;
};

export type GatewayRestartReadinessGate = GatewayRestartReadiness & {
  blocked: boolean;
  threshold: number;
  summary: string;
};

export type GatewayRestartIntent = {
  version: 1;
  reason?: string;
  triggeredBy?: string;
};

let manifestWriteChain = Promise.resolve();

function resolveRestartManifestPath(
  cfg: OpenClawConfig = loadConfig(),
  env: NodeJS.ProcessEnv = process.env,
): string {
  const configured = cfg.gateway?.restart?.manifestPath?.trim();
  const relative = configured || DEFAULT_MANIFEST_PATH;
  return path.resolve(resolveStateDir(env), relative);
}

function resolveRestartIntentPath(env: NodeJS.ProcessEnv = process.env): string {
  return path.resolve(resolveStateDir(env), RESTART_INTENT_FILENAME);
}

function resolveLastMessagePreview(params: {
  storePath: string;
  agentId?: string;
  sessionId?: string;
  sessionFile?: string;
}): string | undefined {
  if (!params.sessionId) {
    return undefined;
  }
  return (
    readLastMessagePreviewFromTranscript(
      params.sessionId,
      params.storePath,
      params.sessionFile,
      params.agentId,
    ) ?? undefined
  );
}

function loadCronJobs(cfg: OpenClawConfig): CronJob[] {
  const storePath = resolveCronStorePath(cfg.cron?.store);
  try {
    const raw = fsSync.readFileSync(storePath, "utf8");
    const parsed = JSON.parse(raw) as { jobs?: unknown };
    return Array.isArray(parsed.jobs) ? (parsed.jobs as CronJob[]) : [];
  } catch {
    return [];
  }
}

function buildActiveSubagents(childSessions: string[] | undefined): RestartManifestSubagent[] {
  const activeSubagents: RestartManifestSubagent[] = [];
  for (const childSessionKey of childSessions ?? []) {
    const run = getLatestSubagentRunByChildSessionKey(childSessionKey);
    if (!run || typeof run.endedAt === "number") {
      continue;
    }
    activeSubagents.push({
      sessionKey: childSessionKey,
      task: run.task,
      label: run.label,
    });
  }
  return activeSubagents;
}

function buildRestartManifestActiveSession(params: {
  session: GatewaySessionRow;
  storePath: string;
  sessionFile?: string;
}): RestartManifestActiveSession | null {
  const { session } = params;
  const activeSubagents = buildActiveSubagents(session.childSessions);
  if (!ACTIVE_SESSION_STATUS.has(session.status ?? "") && activeSubagents.length === 0) {
    return null;
  }
  return {
    key: session.key,
    status:
      activeSubagents.length > 0 && !session.status ? "waiting" : (session.status ?? "running"),
    updatedAt: session.updatedAt,
    channel: session.channel ?? session.lastChannel,
    channelTarget: session.lastTo ?? undefined,
    threadId: session.lastThreadId,
    lastMessagePreview: resolveLastMessagePreview({
      storePath: params.storePath,
      agentId: parseAgentSessionKey(session.key)?.agentId,
      sessionId: session.sessionId,
      sessionFile: params.sessionFile,
    }),
    activeSubagents,
  };
}

export function resolveGatewayRestartConfig(
  cfg: OpenClawConfig = loadConfig(),
): GatewayRestartConfig {
  return {
    sessionRecovery: cfg.gateway?.restart?.sessionRecovery !== false,
    cronRetryOnInterrupt: cfg.gateway?.restart?.cronRetryOnInterrupt !== false,
    readinessGate: cfg.gateway?.restart?.readinessGate !== false,
    readinessGateThreshold: Math.max(0, cfg.gateway?.restart?.readinessGateThreshold ?? 0),
    drainQueueMessages: cfg.gateway?.restart?.drainQueueMessages !== false,
    manifestPath: resolveRestartManifestPath(cfg),
  };
}

export function inspectGatewayRestartReadiness(
  cfg: OpenClawConfig = loadConfig(),
): GatewayRestartReadiness {
  const { storePath, store } = loadCombinedSessionStoreForGateway(cfg);
  const listed = listSessionsFromStore({
    cfg,
    storePath,
    store,
    opts: {
      includeGlobal: false,
      includeUnknown: false,
      includeLastMessage: false,
    },
  });
  const activeSessions: RestartManifestActiveSession[] = [];
  for (const session of listed.sessions) {
    const activeSession = buildRestartManifestActiveSession({
      session,
      storePath,
      sessionFile: store[session.key]?.sessionFile,
    });
    if (activeSession) {
      activeSessions.push(activeSession);
    }
  }

  const activeCronRuns = loadCronJobs(cfg)
    .filter((job) => typeof job.state.runningAtMs === "number")
    .map((job) => ({
      jobId: job.id,
      jobName: job.name,
      startedAt: job.state.runningAtMs as number,
      status: "running" as const,
    }));

  return {
    activeSessions,
    activeCronRuns,
    totalActive: activeSessions.length + activeCronRuns.length,
  };
}

export function evaluateGatewayRestartReadinessGate(
  cfg: OpenClawConfig = loadConfig(),
): GatewayRestartReadinessGate {
  const restartConfig = resolveGatewayRestartConfig(cfg);
  const readiness = inspectGatewayRestartReadiness(cfg);
  const blocked =
    restartConfig.readinessGate && readiness.totalActive >= restartConfig.readinessGateThreshold;
  const lines = [
    `${readiness.totalActive} active item(s) would be interrupted by gateway restart.`,
  ];
  for (const session of readiness.activeSessions.slice(0, 8)) {
    const subagentCount = session.activeSubagents.length;
    lines.push(
      `session ${session.key} (${session.status}${subagentCount > 0 ? `, ${subagentCount} subagent${subagentCount === 1 ? "" : "s"}` : ""})`,
    );
  }
  for (const run of readiness.activeCronRuns.slice(0, 8)) {
    lines.push(`cron ${run.jobId}${run.jobName ? ` (${run.jobName})` : ""}`);
  }
  if (blocked) {
    lines.push("Re-run with --force to proceed.");
  }
  return {
    ...readiness,
    blocked,
    threshold: restartConfig.readinessGateThreshold,
    summary: lines.join("\n"),
  };
}

async function readManifestFile(manifestPath: string): Promise<RestartManifest | null> {
  try {
    const raw = await fs.readFile(manifestPath, "utf8");
    const parsed = JSON.parse(raw) as RestartManifest;
    if (parsed && parsed.version === 1) {
      return {
        ...parsed,
        activeSessions: Array.isArray(parsed.activeSessions) ? parsed.activeSessions : [],
        activeCronRuns: Array.isArray(parsed.activeCronRuns) ? parsed.activeCronRuns : [],
        queuedMessages: Array.isArray(parsed.queuedMessages) ? parsed.queuedMessages : [],
      };
    }
  } catch {
    return null;
  }
  return null;
}

async function writeManifestFile(manifestPath: string, manifest: RestartManifest): Promise<void> {
  await fs.mkdir(path.dirname(manifestPath), { recursive: true });
  await fs.writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
}

async function readRestartIntentFile(
  env: NodeJS.ProcessEnv = process.env,
): Promise<GatewayRestartIntent | null> {
  const filePath = resolveRestartIntentPath(env);
  try {
    const raw = await fs.readFile(filePath, "utf8");
    const parsed = JSON.parse(raw) as GatewayRestartIntent;
    return parsed?.version === 1 ? parsed : null;
  } catch {
    return null;
  }
}

export async function writeGatewayRestartIntent(intent: {
  reason?: string;
  triggeredBy?: string;
  env?: NodeJS.ProcessEnv;
}): Promise<void> {
  const env = intent.env ?? process.env;
  const filePath = resolveRestartIntentPath(env);
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(
    filePath,
    `${JSON.stringify(
      {
        version: 1,
        reason: intent.reason,
        triggeredBy: intent.triggeredBy,
      } satisfies GatewayRestartIntent,
      null,
      2,
    )}\n`,
    "utf8",
  );
}

export async function consumeGatewayRestartIntent(
  env: NodeJS.ProcessEnv = process.env,
): Promise<GatewayRestartIntent | null> {
  const filePath = resolveRestartIntentPath(env);
  const intent = await readRestartIntentFile(env);
  if (!intent) {
    return null;
  }
  await fs.unlink(filePath).catch(() => undefined);
  return intent;
}

export async function clearGatewayRestartIntent(
  env: NodeJS.ProcessEnv = process.env,
): Promise<void> {
  await fs.unlink(resolveRestartIntentPath(env)).catch(() => undefined);
}

export async function writeGatewayRestartManifest(params: {
  cfg?: OpenClawConfig;
  reason?: string;
  triggeredBy?: string;
}): Promise<RestartManifest | null> {
  const cfg = params.cfg ?? loadConfig();
  const restartConfig = resolveGatewayRestartConfig(cfg);
  if (
    !restartConfig.sessionRecovery &&
    !restartConfig.cronRetryOnInterrupt &&
    !restartConfig.drainQueueMessages
  ) {
    return null;
  }
  const readiness = inspectGatewayRestartReadiness(cfg);
  const manifest: RestartManifest = {
    version: 1,
    timestamp: new Date().toISOString(),
    reason: params.reason,
    triggeredBy: params.triggeredBy,
    activeSessions: readiness.activeSessions,
    activeCronRuns: readiness.activeCronRuns,
    queuedMessages: [],
  };
  await writeManifestFile(restartConfig.manifestPath, manifest);
  return manifest;
}

function formatQueuedInboundMessage(message: RestartManifestQueuedMessage): string {
  const prefixParts = ["Gateway restarted while this inbound message was waiting"];
  const surface = message.surface ?? message.provider;
  if (surface) {
    prefixParts.push(`surface: ${surface}`);
  }
  if (message.sender) {
    prefixParts.push(`from: ${message.sender}`);
  }
  const body = message.bodyForAgent?.trim() || message.body?.trim();
  return body
    ? `[System] ${prefixParts.join(" | ")}\n\nQueued message:\n${body}`
    : `[System] ${prefixParts.join(" | ")}.`;
}

function formatInterruptedSessionMessage(
  manifest: RestartManifest,
  session: RestartManifestActiveSession,
): string {
  const reason = session.status ? ` Status before restart: ${session.status}.` : "";
  const restartReason = manifest.reason ? ` Reason: ${manifest.reason}.` : "";
  return `[System] Gateway restarted at ${manifest.timestamp}.${restartReason}${reason} Review the recent context and finish any unanswered work.`;
}

function formatKilledSubagentMessage(subagent: RestartManifestSubagent): string {
  const task = subagent.task?.trim();
  const label = subagent.label?.trim();
  const name = label || subagent.sessionKey;
  return task
    ? `[System] Subagent ${name} was interrupted by the gateway restart while working on: ${task}`
    : `[System] Subagent ${name} was interrupted by the gateway restart.`;
}

export async function queueDrainRestartMessage(params: {
  cfg?: OpenClawConfig;
  ctx: FinalizedMsgContext;
}): Promise<boolean> {
  const cfg = params.cfg ?? loadConfig();
  const restartConfig = resolveGatewayRestartConfig(cfg);
  if (!restartConfig.drainQueueMessages) {
    return false;
  }
  const sessionKey = params.ctx.SessionKey?.trim();
  if (!sessionKey) {
    return false;
  }
  const queued: RestartManifestQueuedMessage = {
    sessionKey,
    surface: params.ctx.Surface,
    provider: params.ctx.Provider,
    sender: params.ctx.SenderName ?? params.ctx.From,
    threadId: params.ctx.MessageThreadId,
    body: params.ctx.Body,
    bodyForAgent: params.ctx.BodyForAgent,
    receivedAt: Date.now(),
  };
  let queuedToManifest = false;
  manifestWriteChain = manifestWriteChain
    .then(async () => {
      const manifest = await readManifestFile(restartConfig.manifestPath);
      if (!manifest) {
        return;
      }
      manifest.queuedMessages.push(queued);
      await writeManifestFile(restartConfig.manifestPath, manifest);
      queuedToManifest = true;
    })
    .catch(() => {
      // Prevent a write failure from permanently rejecting the chain.
    });
  await manifestWriteChain;
  return queuedToManifest;
}

export async function recoverGatewayRestartManifest(params: {
  cfg?: OpenClawConfig;
  cron?: { enqueueRun: (id: string, mode?: "due" | "force") => Promise<unknown> };
}): Promise<{ recovered: boolean; manifest: RestartManifest | null }> {
  const cfg = params.cfg ?? loadConfig();
  const restartConfig = resolveGatewayRestartConfig(cfg);
  const manifest = await readManifestFile(restartConfig.manifestPath);
  if (!manifest) {
    return { recovered: false, manifest: null };
  }

  for (const session of manifest.activeSessions) {
    if (restartConfig.sessionRecovery) {
      enqueueSystemEvent(formatInterruptedSessionMessage(manifest, session), {
        sessionKey: session.key,
      });
      requestHeartbeatNow({ reason: "restart-recovery", sessionKey: session.key });
    }
    for (const subagent of session.activeSubagents) {
      markSubagentRunTerminated({
        childSessionKey: subagent.sessionKey,
        reason: "gateway restart",
      });
      enqueueSystemEvent(formatKilledSubagentMessage(subagent), {
        sessionKey: session.key,
      });
      requestHeartbeatNow({ reason: "restart-recovery", sessionKey: session.key });
    }
  }

  for (const message of manifest.queuedMessages) {
    enqueueSystemEvent(formatQueuedInboundMessage(message), {
      sessionKey: message.sessionKey,
    });
    requestHeartbeatNow({ reason: "restart-recovery", sessionKey: message.sessionKey });
  }

  if (restartConfig.cronRetryOnInterrupt && params.cron) {
    for (const run of manifest.activeCronRuns) {
      try {
        await params.cron.enqueueRun(run.jobId, "force");
      } catch (err) {
        log.warn(`cron restart recovery failed for ${run.jobId}: ${String(err)}`);
      }
    }
  }

  await fs.unlink(restartConfig.manifestPath).catch(() => undefined);
  return { recovered: true, manifest };
}
