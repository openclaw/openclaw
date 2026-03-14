import fs from "node:fs";
import path from "node:path";
import { resolveDefaultAgentId, resolveSessionAgentId } from "../agents/agent-scope.js";
import type { CliDeps } from "../cli/deps.js";
import { createOutboundSendDeps } from "../cli/outbound-send-deps.js";
import { loadConfig } from "../config/config.js";
import { resolveStateDir } from "../config/paths.js";
import {
  canonicalizeMainSessionAlias,
  resolveAgentIdFromSessionKey,
  resolveAgentMainSessionKey,
  resolveSessionFilePath,
} from "../config/sessions.js";
import { resolveStorePath } from "../config/sessions/paths.js";
import { resolveFailureDestination, sendFailureNotificationAnnounce } from "../cron/delivery.js";
import { runCronIsolatedAgentTurn } from "../cron/isolated-agent.js";
import { resolveDeliveryTarget } from "../cron/isolated-agent/delivery-target.js";
import {
  appendCronRunLog,
  resolveCronRunLogPath,
  resolveCronRunLogPruneOptions,
} from "../cron/run-log.js";
import { CronService } from "../cron/service.js";
import { resolveCronStorePath } from "../cron/store.js";
import { normalizeHttpWebhookUrl } from "../cron/webhook-url.js";
import { isMessageReceivedEvent, registerInternalHook } from "../hooks/internal-hooks.js";
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
import { stripInlineDirectiveTagsFromMessageForDisplay } from "../utils/directive-tags.js";
import { stripEnvelopeFromMessage } from "./chat-sanitize.js";
import { appendInjectedAssistantMessageToTranscript } from "./server-methods/chat-transcript-inject.js";
import { loadSessionEntry } from "./session-utils.js";

export type GatewayCronState = {
  cron: CronService;
  storePath: string;
  cronEnabled: boolean;
};

const CRON_WEBHOOK_TIMEOUT_MS = 10_000;

function trimToOptionalString(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

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
  const mode = params.delivery?.mode?.trim().toLowerCase();
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
    config: params.cfg,
    cliDeps: params.deps,
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
      const WF_CHAIN_PREFIX = "__wf_chain__:";

      // =============================================
      // DEBUG: Log job execution start
      // =============================================
      cronLogger.info(
        {
          jobId: job.id,
          jobName: job.name,
          description: job.description?.substring(0, 200),
          schedule: job.schedule,
          payload: job.payload,
        },
        `cron: starting job execution`,
      );

      // Kiểm tra xem job có encode workflow chain không
      const desc = typeof job.description === "string" ? job.description : "";
      const chainStart = desc.indexOf(WF_CHAIN_PREFIX);

      cronLogger.debug(
        { jobId: job.id, chainStart, descLength: desc.length },
        `cron: checking for workflow chain`,
      );

      // Không có chain → hành vi mặc định (1 agent)
      if (chainStart === -1) {
        cronLogger.info(
          { jobId: job.id },
          `cron: no workflow chain found, running single agent turn`,
        );
        const { agentId, cfg: runtimeConfig } = resolveCronAgent(job.agentId);
        return await runCronIsolatedAgentTurn({
          cfg: runtimeConfig,
          deps: params.deps,
          job,
          message,
          abortSignal,
          agentId,
          sessionKey: `cron:${job.id}`,
          lane: "cron",
        });
      }

      // Parse chain từ description
      type WfChainStep = {
        nodeId: string;
        actionType: string;
        label: string;
        agentId?: string;
        prompt?: string;
        body?: string;
      };

      let chain: WfChainStep[];
      const chainJson = desc.slice(chainStart + WF_CHAIN_PREFIX.length);

      cronLogger.info(
        { jobId: job.id, chainJson: chainJson.substring(0, 500) },
        `cron: parsing workflow chain from description`,
      );

      try {
        chain = JSON.parse(chainJson) as WfChainStep[];
        cronLogger.info(
          {
            jobId: job.id,
            chainLength: chain.length,
            steps: chain.map((s) => ({
              nodeId: s.nodeId,
              actionType: s.actionType,
              label: s.label,
            })),
          },
          `cron: workflow chain parsed successfully`,
        );
      } catch (parseErr) {
        cronLogger.error(
          {
            jobId: job.id,
            error: parseErr instanceof Error ? parseErr.message : String(parseErr),
            chainJson: chainJson.substring(0, 300),
          },
          "cron: failed to parse workflow chain, falling back to single step",
        );
        const { agentId, cfg: runtimeConfig } = resolveCronAgent(job.agentId);
        return await runCronIsolatedAgentTurn({
          cfg: runtimeConfig,
          deps: params.deps,
          job,
          message,
          abortSignal,
          agentId,
          sessionKey: `cron:${job.id}`,
          lane: "cron",
        });
      }

      // =============================================
      // Sequential chain execution
      // Output của mỗi bước được truyền sang bước tiếp qua {{input}}
      // =============================================
      let currentInput = message;
      let lastResult: Awaited<ReturnType<typeof runCronIsolatedAgentTurn>> | undefined;

      cronLogger.info(
        { jobId: job.id, totalSteps: chain.length, initialMessage: currentInput.substring(0, 100) },
        `cron: starting sequential chain execution`,
      );

      for (let stepIdx = 0; stepIdx < chain.length; stepIdx++) {
        const step = chain[stepIdx];
        const stepStartTime = Date.now();

        // Dừng sớm nếu abortSignal kích hoạt
        if (abortSignal?.aborted) {
          cronLogger.warn(
            { jobId: job.id, step: stepIdx + 1, reason: abortSignal.reason },
            "cron: workflow chain aborted by signal",
          );
          return {
            status: "error" as const,
            error: "workflow chain aborted",
            sessionId: `cron:${job.id}:step${stepIdx}`,
            sessionKey: `cron:${job.id}:step${stepIdx}`,
          };
        }

        cronLogger.info(
          {
            jobId: job.id,
            step: stepIdx + 1,
            total: chain.length,
            nodeId: step.nodeId,
            actionType: step.actionType,
            label: step.label,
            promptPreview: step.prompt?.substring(0, 100),
          },
          `cron: executing workflow chain step ${stepIdx + 1}/${chain.length}`,
        );

        if (step.actionType === "agent-prompt" || step.label === "AI Agent Prompt") {
          // Render template: thay {{input}} bằng output của bước trước
          const rawPrompt = step.prompt || currentInput;
          const prompt = rawPrompt.replace(/\{\{input\}\}/g, currentInput);

          cronLogger.debug(
            {
              jobId: job.id,
              step: stepIdx + 1,
              rawPrompt: rawPrompt.substring(0, 150),
              currentInput: currentInput.substring(0, 150),
            },
            `cron: agent-prompt step - rendering template`,
          );

          const { agentId: stepAgentId, cfg: stepCfg } = resolveCronAgent(step.agentId || null);

          cronLogger.info(
            {
              jobId: job.id,
              step: stepIdx + 1,
              agentId: stepAgentId,
              sessionKey: `cron:${job.id}:step${stepIdx}:${step.nodeId}`,
            },
            `cron: calling runCronIsolatedAgentTurn for step ${stepIdx + 1}`,
          );

          cronLogger.info(
            {
              jobId: job.id,
              step: stepIdx + 1,
              nodeId: step.nodeId,
              prompt: prompt,
            },
            `cron: [STEP ${stepIdx + 1}/${chain.length}] STARTING - Node "${step.label || step.nodeId}"`,
          );

          const stepResult = await runCronIsolatedAgentTurn({
            cfg: stepCfg,
            deps: params.deps,
            job,
            message: prompt,
            abortSignal,
            agentId: stepAgentId,
            // Mỗi bước có sessionKey riêng để tránh xung đột lịch sử
            sessionKey: `cron:${job.id}:step${stepIdx}:${step.nodeId}`,
            lane: "cron",
          });

          const stepDuration = Date.now() - stepStartTime;

          // Nếu bước này thất bại, dừng chain ngay
          if (stepResult.status === "error") {
            cronLogger.error(
              {
                jobId: job.id,
                step: stepIdx + 1,
                nodeId: step.nodeId,
                error: stepResult.error,
                durationMs: stepDuration,
                sessionId: stepResult.sessionId,
                sessionKey: stepResult.sessionKey,
              },
              `cron: [STEP ${stepIdx + 1}/${chain.length}] ❌ FAILED - Node "${step.label || step.nodeId}"`,
            );
            return stepResult;
          }

          cronLogger.info(
            {
              jobId: job.id,
              step: stepIdx + 1,
              nodeId: step.nodeId,
              durationMs: stepDuration,
              status: stepResult.status,
              sessionId: stepResult.sessionId,
              sessionKey: stepResult.sessionKey,
              outputTextLength: stepResult.outputText?.length ?? 0,
              delivered: stepResult.delivered,
              deliveryAttempted: stepResult.deliveryAttempted,
            },
            `cron: [STEP ${stepIdx + 1}/${chain.length}] ✅ COMPLETED - Node "${step.label || step.nodeId}"`,
          );

          // Log full output cho step này
          if (stepResult.outputText) {
            cronLogger.info(
              {
                jobId: job.id,
                step: stepIdx + 1,
                nodeId: step.nodeId,
                outputText: stepResult.outputText,
              },
              `cron: [STEP ${stepIdx + 1}/${chain.length}] 📝 OUTPUT - Node "${step.label || step.nodeId}"`,
            );
          }

          // Truyền outputText sang bước tiếp theo
          if (stepResult.outputText) {
            currentInput = stepResult.outputText;
            cronLogger.info(
              {
                jobId: job.id,
                step: stepIdx + 1,
                nextStep: stepIdx + 2,
                newInputLength: currentInput.length,
                newInputPreview: currentInput.substring(0, 300),
              },
              `cron: [CHAIN] Passing output from step ${stepIdx + 1} to step ${stepIdx + 2} as {{input}}`,
            );
          }
          lastResult = stepResult;
        } else if (step.actionType === "send-message" || step.label === "Send Message") {
          // Send message: inject vào session cuối, không chờ AI
          const body = (step.body || currentInput).replace(/\{\{input\}\}/g, currentInput);
          const { agentId: stepAgentId } = resolveCronAgent(null);
          const sessionKey = `cron:${job.id}:step${stepIdx}:${step.nodeId}`;

          cronLogger.info(
            {
              jobId: job.id,
              step: stepIdx + 1,
              nodeId: step.nodeId,
              sessionKey,
              body: body,
            },
            `cron: [STEP ${stepIdx + 1}/${chain.length}] 📤 SEND-MESSAGE - Node "${step.label || step.nodeId}"`,
          );

          enqueueSystemEvent(body, { sessionKey });

          cronLogger.info(
            {
              jobId: job.id,
              step: stepIdx + 1,
              nodeId: step.nodeId,
              sessionKey,
              enqueued: true,
            },
            `cron: [STEP ${stepIdx + 1}/${chain.length}] ✅ ENQUEUED - Node "${step.label || step.nodeId}"`,
          );

          // send-message không thay đổi currentInput
          lastResult = {
            status: "ok" as const,
            sessionId: sessionKey,
            sessionKey,
          };
          void stepAgentId; // suppress unused warning
        } else {
          // Action type chưa được hỗ trợ — log và bỏ qua
          cronLogger.warn(
            {
              jobId: job.id,
              step: stepIdx + 1,
              nodeId: step.nodeId,
              actionType: step.actionType,
              label: step.label,
            },
            "cron: unsupported workflow chain action type, skipping step",
          );
        }
      }

      const _totalDuration = Date.now();
      const successCount = chain.filter((_, idx) => {
        const step = chain[idx];
        return (
          step.actionType === "agent-prompt" ||
          step.label === "AI Agent Prompt" ||
          step.actionType === "send-message" ||
          step.label === "Send Message"
        );
      }).length;

      cronLogger.info(
        {
          jobId: job.id,
          totalSteps: chain.length,
          executedSteps: successCount,
          finalStatus: lastResult?.status ?? "unknown",
          finalSessionId: lastResult?.sessionId,
          finalSessionKey: lastResult?.sessionKey,
          finalOutputLength: lastResult?.outputText?.length ?? 0,
          finalOutput: lastResult?.outputText,
          delivered: lastResult?.delivered,
          deliveryAttempted: lastResult?.deliveryAttempted,
        },
        `cron: [WORKFLOW COMPLETE] ✅ Chain execution finished - ${successCount}/${chain.length} steps executed`,
      );

      // Trả về kết quả của bước cuối cùng
      return (
        lastResult ?? {
          status: "ok" as const,
          sessionId: `cron:${job.id}`,
          sessionKey: `cron:${job.id}`,
        }
      );
    },
    sendCronFailureAlert: async ({ job, text, channel, to, mode, accountId }) => {
      const { agentId, cfg: runtimeConfig } = resolveCronAgent(job.agentId);
      const webhookToken = trimToOptionalString(params.cfg.cron?.webhookToken);

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
        const webhookToken = trimToOptionalString(params.cfg.cron?.webhookToken);
        const legacyWebhook = trimToOptionalString(params.cfg.cron?.webhook);
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
          const failureDest = resolveFailureDestination(job, params.cfg.cron?.failureDestination);
          if (failureDest) {
            const isBestEffort =
              job.delivery?.bestEffort === true ||
              (job.payload.kind === "agentTurn" && job.payload.bestEffortDeliver === true);

            if (!isBestEffort) {
              const failureMessage = `Cron job "${job.name}" failed: ${evt.error ?? "unknown error"}`;
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
                  },
                  `[Cron Failure] ${failureMessage}`,
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

  registerInternalHook("message:received", async (evt) => {
    const log = getChildLogger({ subsystem: "workflow" });
    if (!isMessageReceivedEvent(evt)) {
      log.error(`[Workflow] not isMessageReceivedEvent`);
      return;
    }
    try {
      const stateDir = resolveStateDir(process.env);
      const filePath = path.join(stateDir, "workflows", "workflows.json");
      if (!fs.existsSync(filePath)) {
        return;
      }

      const data = fs.readFileSync(filePath, "utf-8");
      const workflows = JSON.parse(data) as Array<{
        name?: string;
        nodes?: Array<{ id: string; type: string; data?: Record<string, string | undefined> }>;
        edges?: Array<{ source: string; target: string }>;
      }>;
      const incomingSessionKey = evt.sessionKey;
      const incomingMsg = typeof evt.context.content === "string" ? evt.context.content : "";

      log.info(
        `[Workflow] Incoming message received in session: ${incomingSessionKey}. Evaluating triggers...`,
      );

      if (!Array.isArray(workflows)) {
        return;
      }

      for (const wf of workflows) {
        if (!wf.nodes || !wf.edges) {
          continue;
        }
        const triggers = wf.nodes.filter((n) => n.data?.triggerType === "chat");

        for (const trigger of triggers) {
          const targetSessionKey = trigger.data?.targetSessionKey;
          const matchKeyword = trigger.data?.matchKeyword;

          let match = false;
          if (!targetSessionKey || targetSessionKey === "*") {
            match = true;
          } else {
            match = incomingSessionKey === targetSessionKey;
          }

          if (match && matchKeyword && matchKeyword.trim() !== "") {
            match = incomingMsg.toLowerCase().includes(matchKeyword.toLowerCase());
          }

          if (match) {
            const visited = new Set<string>();
            const queue: Array<{ nodeId: string; input: string }> = [];

            const startEdges = wf.edges.filter((e) => e.source === trigger.id);
            for (const startEdge of startEdges) {
              queue.push({ nodeId: startEdge.target, input: incomingMsg });
            }

            while (queue.length > 0) {
              const current = queue.shift();
              if (!current) {
                continue;
              }

              // Cycle Detection: Prevent infinite loops
              if (visited.has(current.nodeId)) {
                continue;
              }
              visited.add(current.nodeId);

              const actionNode = wf.nodes.find((n) => n.id === current.nodeId);
              if (!actionNode || actionNode.type !== "action") {
                continue;
              }

              const actionType = actionNode.data?.actionType;
              let jobSessionKey: string = incomingSessionKey;

              if (actionType === "ai-agent" || actionType === "agent-prompt") {
                let prompt = actionNode.data?.prompt || "";
                prompt = prompt.replace(/\{\{input\}\}/g, current.input);
                if (targetSessionKey && targetSessionKey !== "*") {
                  jobSessionKey = targetSessionKey;
                }

                enqueueSystemEvent(`[Workflow Prompt]: ${prompt}`, { sessionKey: jobSessionKey });
                requestHeartbeatNow({ sessionKey: jobSessionKey, reason: "workflow_action" });
              } else if (actionType === "system-event") {
                let text = actionNode.data?.systemEventText || "System Event Occurred";
                text = text.replace(/\{\{input\}\}/g, current.input);
                jobSessionKey = incomingSessionKey;
                enqueueSystemEvent(text, { sessionKey: jobSessionKey });
              } else if (actionType === "send-message") {
                let body = actionNode.data?.messageBody || "";
                body = body.replace(/\{\{input\}\}/g, current.input);
                if (targetSessionKey && targetSessionKey !== "*") {
                  jobSessionKey = targetSessionKey;
                }

                const { cfg, storePath, entry } = loadSessionEntry(jobSessionKey);
                const sessionId = entry?.sessionId;
                if (sessionId && storePath) {
                  const agentId = resolveSessionAgentId({
                    sessionKey: jobSessionKey,
                    config: cfg,
                  });
                  const sessionsDir = path.dirname(storePath);
                  let transcriptPath: string | null = null;
                  try {
                    transcriptPath = resolveSessionFilePath(
                      sessionId,
                      entry?.sessionFile ? { sessionFile: entry.sessionFile } : undefined,
                      sessionsDir || agentId ? { sessionsDir, agentId } : undefined,
                    );
                  } catch {
                    // ignore
                  }
                  if (transcriptPath) {
                    if (!fs.existsSync(transcriptPath)) {
                      fs.mkdirSync(path.dirname(transcriptPath), { recursive: true });
                      fs.writeFileSync(transcriptPath, "");
                    }
                    const appended = appendInjectedAssistantMessageToTranscript({
                      message: body,
                      transcriptPath,
                    });
                    if (appended.ok && appended.messageId && appended.message) {
                      const chatPayload = {
                        runId: `wf-${appended.messageId}`,
                        sessionKey: jobSessionKey,
                        seq: 0,
                        state: "final" as const,
                        message: stripInlineDirectiveTagsFromMessageForDisplay(
                          stripEnvelopeFromMessage(appended.message) as Record<string, unknown>,
                        ),
                      };
                      params.broadcast("chat", chatPayload);
                    }
                  }
                }
              }

              // Traversal: Find next nodes connected to the current one
              const nextEdges = wf.edges.filter((e) => e.source === current.nodeId);
              for (const nextEdge of nextEdges) {
                queue.push({ nodeId: nextEdge.target, input: current.input });
              }
            }
          }
        }
      }
    } catch (e) {
      cronLogger.warn({ err: String(e) }, "cron: workflow trigger matching failed");
    }
  });

  return { cron, storePath, cronEnabled };
}
