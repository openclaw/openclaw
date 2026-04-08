import { spawn } from "node:child_process";
import { resolveDefaultAgentId } from "../agents/agent-scope.js";
import { cleanupBrowserSessionsForLifecycleEnd } from "../browser-lifecycle-cleanup.js";
import type { CliDeps } from "../cli/deps.js";
import { createOutboundSendDeps } from "../cli/outbound-send-deps.js";
import { loadConfig } from "../config/config.js";
import {
  canonicalizeMainSessionAlias,
  resolveAgentIdFromSessionKey,
  resolveAgentMainSessionKey,
} from "../config/sessions.js";
import { resolveStorePath } from "../config/sessions/paths.js";
import {
  resolveCronDeliveryPlan,
  resolveFailureDestination,
  sendFailureNotificationAnnounce,
} from "../cron/delivery.js";
import { runCronIsolatedAgentTurn } from "../cron/isolated-agent.js";
import { resolveDeliveryTarget } from "../cron/isolated-agent/delivery-target.js";
import {
  appendCronRunLog,
  resolveCronRunLogPath,
  resolveCronRunLogPruneOptions,
} from "../cron/run-log.js";
import { CronService } from "../cron/service.js";
import { assertSafeCronSessionTargetId } from "../cron/session-target.js";
import { resolveCronStorePath } from "../cron/store.js";
import { normalizeHttpWebhookUrl } from "../cron/webhook-url.js";
import { formatErrorMessage } from "../infra/errors.js";
import { runHeartbeatOnce } from "../infra/heartbeat-runner.js";
import { requestHeartbeatNow } from "../infra/heartbeat-wake.js";
import { fetchWithSsrFGuard } from "../infra/net/fetch-guard.js";
import { SsrFBlockedError } from "../infra/net/ssrf.js";
import { deliverOutboundPayloads } from "../infra/outbound/deliver.js";
import { enqueueSystemEvent } from "../infra/system-events.js";
import { getChildLogger } from "../logging.js";
import { normalizeAgentId, toAgentStoreSessionKey } from "../routing/session-key.js";
import { defaultRuntime } from "../runtime.js";
import {
  normalizeOptionalLowercaseString,
  normalizeOptionalString,
} from "../shared/string-coerce.js";

export type GatewayCronState = {
  cron: CronService;
  storePath: string;
  cronEnabled: boolean;
};

const CRON_WEBHOOK_TIMEOUT_MS = 10_000;

function redactWebhookUrl(url: string): string {
  try {
    const parsed = new URL(url);
    return `${parsed.origin}${parsed.pathname}`;
  } catch {
    return "<invalid-webhook-url>";
  }
}

type CronWebhookTarget = {
  url: string;
  source: "delivery" | "legacy";
};

function resolveCronWebhookTarget(params: {
  delivery?: { mode?: string; to?: string };
  legacyNotify?: boolean;
  legacyWebhook?: string;
}): CronWebhookTarget | null {
  const mode = normalizeOptionalLowercaseString(params.delivery?.mode);
  if (mode === "webhook") {
    const url = normalizeHttpWebhookUrl(params.delivery?.to);
    return url ? { url, source: "delivery" } : null;
  }

  if (params.legacyNotify) {
    const legacyUrl = normalizeHttpWebhookUrl(params.legacyWebhook);
    if (legacyUrl) {
      return { url: legacyUrl, source: "legacy" };
    }
  }

  return null;
}

const CRON_COMMAND_OUTPUT_LIMIT_BYTES = 64 * 1024;

function buildCronWebhookHeaders(webhookToken?: string): Record<string, string> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };
  if (webhookToken) {
    headers.Authorization = `Bearer ${webhookToken}`;
  }
  return headers;
}

async function postCronWebhook(params: {
  webhookUrl: string;
  webhookToken?: string;
  payload: unknown;
  logContext: Record<string, unknown>;
  blockedLog: string;
  failedLog: string;
  logger: ReturnType<typeof getChildLogger>;
}): Promise<void> {
  const abortController = new AbortController();
  const timeout = setTimeout(() => {
    abortController.abort();
  }, CRON_WEBHOOK_TIMEOUT_MS);

  try {
    const result = await fetchWithSsrFGuard({
      url: params.webhookUrl,
      init: {
        method: "POST",
        headers: buildCronWebhookHeaders(params.webhookToken),
        body: JSON.stringify(params.payload),
        signal: abortController.signal,
      },
    });
    await result.release();
  } catch (err) {
    if (err instanceof SsrFBlockedError) {
      params.logger.warn(
        {
          ...params.logContext,
          reason: formatErrorMessage(err),
          webhookUrl: redactWebhookUrl(params.webhookUrl),
        },
        params.blockedLog,
      );
    } else {
      params.logger.warn(
        {
          ...params.logContext,
          err: formatErrorMessage(err),
          webhookUrl: redactWebhookUrl(params.webhookUrl),
        },
        params.failedLog,
      );
    }
  } finally {
    clearTimeout(timeout);
  }
}

async function runCronCommandJob(params: {
  command: string;
  args?: string[];
  timeoutSeconds?: number;
  abortSignal?: AbortSignal;
}): Promise<{
  status: "ok" | "error" | "aborted";
  summary?: string;
  outputText?: string;
  error?: string;
  delivered?: boolean;
  deliveryAttempted?: boolean;
}> {
  const command = params.command.trim();
  const args = Array.isArray(params.args) ? params.args.filter((entry) => entry.length > 0) : [];
  if (!command) {
    return { status: "error" as const, error: "cron command payload requires a non-empty command" };
  }

  return await new Promise<{
    status: "ok" | "error" | "aborted";
    summary?: string;
    outputText?: string;
    error?: string;
    delivered?: boolean;
    deliveryAttempted?: boolean;
  }>((resolve) => {
    const child = spawn(command, args, {
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
      env: process.env,
    });

    let stdout = "";
    let stderr = "";
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let settled = false;
    let timedOut = false;

    const appendLimited = (current: string, chunk: Buffer, used: number) => {
      if (used >= CRON_COMMAND_OUTPUT_LIMIT_BYTES) {
        return { text: current, bytes: used };
      }
      const remaining = CRON_COMMAND_OUTPUT_LIMIT_BYTES - used;
      const slice = chunk.subarray(0, remaining);
      return { text: current + slice.toString("utf8"), bytes: used + slice.byteLength };
    };

    const finish = (result: {
      status: "ok" | "error" | "aborted";
      summary?: string;
      outputText?: string;
      error?: string;
      delivered?: boolean;
      deliveryAttempted?: boolean;
    }) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timeout);
      params.abortSignal?.removeEventListener("abort", onAbort);
      resolve(result);
    };

    let aborted = false;
    const onAbort = () => {
      aborted = true;
      child.kill("SIGTERM");
    };

    params.abortSignal?.addEventListener("abort", onAbort, { once: true });

    child.stdout?.on("data", (chunk: Buffer) => {
      const next = appendLimited(stdout, chunk, stdoutBytes);
      stdout = next.text;
      stdoutBytes = next.bytes;
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      const next = appendLimited(stderr, chunk, stderrBytes);
      stderr = next.text;
      stderrBytes = next.bytes;
    });

    child.once("error", (err) => {
      finish({ status: "error", error: formatErrorMessage(err) });
    });

    child.once("close", (code, signal) => {
      const outputText = stdout.trim() || undefined;
      const errorText = stderr.trim() || undefined;
      if (timedOut) {
        finish({
          status: "error",
          error: `command timed out after ${params.timeoutSeconds ?? 0}s`,
          summary: errorText ?? outputText,
          outputText,
        });
        return;
      }
      if (aborted) {
        finish({
          status: "aborted",
          error: "aborted",
          summary: errorText ?? outputText,
          outputText,
        });
        return;
      }
      if (code === 0) {
        finish({
          status: "ok",
          summary: outputText ?? errorText ?? `Command completed: ${command}`,
          outputText,
        });
        return;
      }
      finish({
        status: "error",
        error:
          errorText ??
          `command exited with code ${code ?? "unknown"}${signal ? ` (signal ${signal})` : ""}`,
        summary: errorText ?? outputText,
        outputText,
      });
    });

    const timeoutMs =
      typeof params.timeoutSeconds === "number" && Number.isFinite(params.timeoutSeconds)
        ? Math.max(0, params.timeoutSeconds) * 1000
        : 0;
    const timeout: ReturnType<typeof setTimeout> | undefined =
      timeoutMs > 0
        ? setTimeout(() => {
            timedOut = true;
            child.kill("SIGTERM");
          }, timeoutMs)
        : undefined;
    timeout?.unref?.();
  });
}

export function buildGatewayCronService(params: {
  cfg: ReturnType<typeof loadConfig>;
  deps: CliDeps;
  broadcast: (event: string, payload: unknown, opts?: { dropIfSlow?: boolean }) => void;
}): GatewayCronState {
  const cronLogger = getChildLogger({ module: "cron" });
  const storePath = resolveCronStorePath(params.cfg.cron?.store);
  const cronEnabled = process.env.OPENCLAW_SKIP_CRON !== "1" && params.cfg.cron?.enabled !== false;

  const resolveCronAgent = (requested?: string | null) => {
    const runtimeConfig = loadConfig();
    const normalized =
      typeof requested === "string" && requested.trim() ? normalizeAgentId(requested) : undefined;
    const hasAgent =
      normalized !== undefined &&
      Array.isArray(runtimeConfig.agents?.list) &&
      runtimeConfig.agents.list.some(
        (entry) =>
          entry && typeof entry.id === "string" && normalizeAgentId(entry.id) === normalized,
      );
    const agentId = hasAgent ? normalized : resolveDefaultAgentId(runtimeConfig);
    return { agentId, cfg: runtimeConfig };
  };

  const resolveCronSessionKey = (params: {
    runtimeConfig: ReturnType<typeof loadConfig>;
    agentId: string;
    requestedSessionKey?: string | null;
  }) => {
    const requested = params.requestedSessionKey?.trim();
    if (!requested) {
      return resolveAgentMainSessionKey({
        cfg: params.runtimeConfig,
        agentId: params.agentId,
      });
    }
    const candidate = toAgentStoreSessionKey({
      agentId: params.agentId,
      requestKey: requested,
      mainKey: params.runtimeConfig.session?.mainKey,
    });
    const canonical = canonicalizeMainSessionAlias({
      cfg: params.runtimeConfig,
      agentId: params.agentId,
      sessionKey: candidate,
    });
    if (canonical !== "global") {
      const sessionAgentId = resolveAgentIdFromSessionKey(canonical);
      if (normalizeAgentId(sessionAgentId) !== normalizeAgentId(params.agentId)) {
        return resolveAgentMainSessionKey({
          cfg: params.runtimeConfig,
          agentId: params.agentId,
        });
      }
    }
    return canonical;
  };

  const resolveCronWakeTarget = (opts?: { agentId?: string; sessionKey?: string | null }) => {
    const runtimeConfig = loadConfig();
    const requestedAgentId = opts?.agentId ? resolveCronAgent(opts.agentId).agentId : undefined;
    const derivedAgentId =
      requestedAgentId ??
      (opts?.sessionKey
        ? normalizeAgentId(resolveAgentIdFromSessionKey(opts.sessionKey))
        : undefined);
    const agentId = derivedAgentId || undefined;
    const sessionKey =
      opts?.sessionKey && agentId
        ? resolveCronSessionKey({
            runtimeConfig,
            agentId,
            requestedSessionKey: opts.sessionKey,
          })
        : undefined;
    return { runtimeConfig, agentId, sessionKey };
  };

  const defaultAgentId = resolveDefaultAgentId(params.cfg);
  const runLogPrune = resolveCronRunLogPruneOptions(params.cfg.cron?.runLog);
  const resolveSessionStorePath = (agentId?: string) =>
    resolveStorePath(params.cfg.session?.store, {
      agentId: agentId ?? defaultAgentId,
    });
  const sessionStorePath = resolveSessionStorePath(defaultAgentId);
  const warnedLegacyWebhookJobs = new Set<string>();

  const cron = new CronService({
    storePath,
    cronEnabled,
    cronConfig: params.cfg.cron,
    defaultAgentId,
    resolveSessionStorePath,
    sessionStorePath,
    enqueueSystemEvent: (text, opts) => {
      const { agentId, cfg: runtimeConfig } = resolveCronAgent(opts?.agentId);
      const sessionKey = resolveCronSessionKey({
        runtimeConfig,
        agentId,
        requestedSessionKey: opts?.sessionKey,
      });
      enqueueSystemEvent(text, { sessionKey, contextKey: opts?.contextKey });
    },
    requestHeartbeatNow: (opts) => {
      const { agentId, sessionKey } = resolveCronWakeTarget(opts);
      requestHeartbeatNow({
        reason: opts?.reason,
        agentId,
        sessionKey,
      });
    },
    runHeartbeatOnce: async (opts) => {
      const { runtimeConfig, agentId, sessionKey } = resolveCronWakeTarget(opts);
      // Merge cron-supplied heartbeat overrides (e.g. target: "last") with the
      // fully resolved agent heartbeat config so cron-triggered heartbeats
      // respect agent-specific overrides (agents.list[].heartbeat) before
      // falling back to agents.defaults.heartbeat.
      const agentEntry =
        Array.isArray(runtimeConfig.agents?.list) &&
        runtimeConfig.agents.list.find(
          (entry) =>
            entry && typeof entry.id === "string" && normalizeAgentId(entry.id) === agentId,
        );
      const agentHeartbeat =
        agentEntry && typeof agentEntry === "object" ? agentEntry.heartbeat : undefined;
      const baseHeartbeat = {
        ...runtimeConfig.agents?.defaults?.heartbeat,
        ...agentHeartbeat,
      };
      const heartbeatOverride = opts?.heartbeat
        ? { ...baseHeartbeat, ...opts.heartbeat }
        : undefined;
      return await runHeartbeatOnce({
        cfg: runtimeConfig,
        reason: opts?.reason,
        agentId,
        sessionKey,
        heartbeat: heartbeatOverride,
        deps: { ...params.deps, runtime: defaultRuntime },
      });
    },
    runIsolatedAgentJob: async ({ job, message, abortSignal }) => {
      const { agentId, cfg: runtimeConfig } = resolveCronAgent(job.agentId);
      let sessionKey = `cron:${job.id}`;
      if (job.sessionTarget.startsWith("session:")) {
        sessionKey = assertSafeCronSessionTargetId(job.sessionTarget.slice(8));
      }
      try {
        return await runCronIsolatedAgentTurn({
          cfg: runtimeConfig,
          deps: params.deps,
          job,
          message,
          abortSignal,
          agentId,
          sessionKey,
          lane: "cron",
        });
      } finally {
        await cleanupBrowserSessionsForLifecycleEnd({
          sessionKeys: [sessionKey],
          onWarn: (msg) => cronLogger.warn({ jobId: job.id }, msg),
        });
      }
    },
    runCommandJob: async ({ command, args, timeoutSeconds, abortSignal }) =>
      await runCronCommandJob({ command, args, timeoutSeconds, abortSignal }),
    sendCronFailureAlert: async ({ job, text, channel, to, mode, accountId }) => {
      const { agentId, cfg: runtimeConfig } = resolveCronAgent(job.agentId);
      const webhookToken = normalizeOptionalString(params.cfg.cron?.webhookToken);

      // Webhook mode requires a URL - fail closed if missing
      if (mode === "webhook" && !to) {
        cronLogger.warn(
          { jobId: job.id },
          "cron: failure alert webhook mode requires URL, skipping",
        );
        return;
      }

      if (mode === "webhook" && to) {
        const webhookUrl = normalizeHttpWebhookUrl(to);
        if (webhookUrl) {
          await postCronWebhook({
            webhookUrl,
            webhookToken,
            payload: {
              jobId: job.id,
              jobName: job.name,
              message: text,
            },
            logContext: { jobId: job.id },
            blockedLog: "cron: failure alert webhook blocked by SSRF guard",
            failedLog: "cron: failure alert webhook failed",
            logger: cronLogger,
          });
        } else {
          cronLogger.warn(
            {
              jobId: job.id,
              webhookUrl: redactWebhookUrl(to),
            },
            "cron: failure alert webhook URL is invalid, skipping",
          );
        }
        return;
      }

      const target = await resolveDeliveryTarget(runtimeConfig, agentId, {
        channel,
        to,
        accountId,
      });
      if (!target.ok) {
        throw target.error;
      }
      await deliverOutboundPayloads({
        cfg: runtimeConfig,
        channel: target.channel,
        to: target.to,
        accountId: target.accountId,
        threadId: target.threadId,
        payloads: [{ text }],
        deps: createOutboundSendDeps(params.deps),
      });
    },
    log: getChildLogger({ module: "cron", storePath }),
    onEvent: (evt) => {
      params.broadcast("cron", evt, { dropIfSlow: true });
      if (evt.action === "finished") {
        const webhookToken = normalizeOptionalString(params.cfg.cron?.webhookToken);
        const legacyWebhook = normalizeOptionalString(params.cfg.cron?.webhook);
        const job = cron.getJob(evt.jobId);
        const legacyNotify = (job as { notify?: unknown } | undefined)?.notify === true;
        const webhookTarget = resolveCronWebhookTarget({
          delivery:
            job?.delivery && typeof job.delivery.mode === "string"
              ? { mode: job.delivery.mode, to: job.delivery.to }
              : undefined,
          legacyNotify,
          legacyWebhook,
        });

        if (!webhookTarget && job?.delivery?.mode === "webhook") {
          cronLogger.warn(
            {
              jobId: evt.jobId,
              deliveryTo: job.delivery.to,
            },
            "cron: skipped webhook delivery, delivery.to must be a valid http(s) URL",
          );
        }

        if (webhookTarget?.source === "legacy" && !warnedLegacyWebhookJobs.has(evt.jobId)) {
          warnedLegacyWebhookJobs.add(evt.jobId);
          cronLogger.warn(
            {
              jobId: evt.jobId,
              legacyWebhook: redactWebhookUrl(webhookTarget.url),
            },
            "cron: deprecated notify+cron.webhook fallback in use, migrate to delivery.mode=webhook with delivery.to",
          );
        }

        if (webhookTarget && evt.summary) {
          void (async () => {
            await postCronWebhook({
              webhookUrl: webhookTarget.url,
              webhookToken,
              payload: evt,
              logContext: { jobId: evt.jobId },
              blockedLog: "cron: webhook delivery blocked by SSRF guard",
              failedLog: "cron: webhook delivery failed",
              logger: cronLogger,
            });
          })();
        }

        if (evt.status === "error" && job) {
          const isBestEffort = job.delivery?.bestEffort === true;
          if (!isBestEffort) {
            const failureMessage = `Cron job "${job.name}" failed: ${evt.error ?? "unknown error"}`;
            const failureDest = resolveFailureDestination(job, params.cfg.cron?.failureDestination);

            if (failureDest) {
              // Explicit failureDestination configured — use it
              const failurePayload = {
                jobId: job.id,
                jobName: job.name,
                message: failureMessage,
                status: evt.status,
                error: evt.error,
                runAtMs: evt.runAtMs,
                durationMs: evt.durationMs,
                nextRunAtMs: evt.nextRunAtMs,
              };

              if (failureDest.mode === "webhook" && failureDest.to) {
                const webhookUrl = normalizeHttpWebhookUrl(failureDest.to);
                if (webhookUrl) {
                  void (async () => {
                    await postCronWebhook({
                      webhookUrl,
                      webhookToken,
                      payload: failurePayload,
                      logContext: { jobId: evt.jobId },
                      blockedLog: "cron: failure destination webhook blocked by SSRF guard",
                      failedLog: "cron: failure destination webhook failed",
                      logger: cronLogger,
                    });
                  })();
                } else {
                  cronLogger.warn(
                    {
                      jobId: evt.jobId,
                      webhookUrl: redactWebhookUrl(failureDest.to),
                    },
                    "cron: failure destination webhook URL is invalid, skipping",
                  );
                }
              } else if (failureDest.mode === "announce") {
                const { agentId, cfg: runtimeConfig } = resolveCronAgent(job.agentId);
                void sendFailureNotificationAnnounce(
                  params.deps,
                  runtimeConfig,
                  agentId,
                  job.id,
                  {
                    channel: failureDest.channel,
                    to: failureDest.to,
                    accountId: failureDest.accountId,
                    sessionKey: job.sessionKey,
                  },
                  `⚠️ ${failureMessage}`,
                );
              }
            } else {
              // No explicit failureDestination — fall back to primary delivery channel (#60608)
              const primaryPlan = resolveCronDeliveryPlan(job);
              if (primaryPlan.mode === "announce" && primaryPlan.requested) {
                const { agentId, cfg: runtimeConfig } = resolveCronAgent(job.agentId);
                void sendFailureNotificationAnnounce(
                  params.deps,
                  runtimeConfig,
                  agentId,
                  job.id,
                  {
                    channel: primaryPlan.channel,
                    to: primaryPlan.to,
                    accountId: primaryPlan.accountId,
                    sessionKey: job.sessionKey,
                  },
                  `⚠️ ${failureMessage}`,
                );
              }
            }
          }
        }

        const logPath = resolveCronRunLogPath({
          storePath,
          jobId: evt.jobId,
        });
        void appendCronRunLog(
          logPath,
          {
            ts: Date.now(),
            jobId: evt.jobId,
            action: "finished",
            status: evt.status,
            error: evt.error,
            summary: evt.summary,
            delivered: evt.delivered,
            deliveryStatus: evt.deliveryStatus,
            deliveryError: evt.deliveryError,
            sessionId: evt.sessionId,
            sessionKey: evt.sessionKey,
            runAtMs: evt.runAtMs,
            durationMs: evt.durationMs,
            nextRunAtMs: evt.nextRunAtMs,
            model: evt.model,
            provider: evt.provider,
            usage: evt.usage,
          },
          runLogPrune,
        ).catch((err) => {
          cronLogger.warn({ err: String(err), logPath }, "cron: run log append failed");
        });
      }
    },
  });

  return { cron, storePath, cronEnabled };
}
