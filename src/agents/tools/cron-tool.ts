import { normalizeLowercaseStringOrEmpty } from "@openclaw/normalization-core/string-coerce";
import { parseDurationMs } from "../../cli/parse-duration.js";
import { getRuntimeConfig } from "../../config/config.js";
import { resolveCronCreationDelivery } from "../../cron/delivery-context.js";
import { assertCronDeliveryInputNonBlankFields } from "../../cron/delivery-target-validation.js";
import { normalizeCronJobCreate, normalizeCronJobPatch } from "../../cron/normalize.js";
import type { CronDelivery } from "../../cron/types.js";
import { normalizeHttpWebhookUrl } from "../../cron/webhook-url.js";
import { GatewayClientRequestError } from "../../gateway/client.js";
import { CRON_MANAGEMENT_METHODS } from "../../gateway/cron-creator-authority-grant.js";
import {
  createAutomationResultRecorder,
  createAutomationRunGuard,
  recordCronNextCheckProposal,
} from "../../infra/agent-run-registry.automation.js";
import { getAgentRunContext } from "../../infra/agent-run-registry.js";
import { parseAgentSessionKey } from "../../sessions/session-key-utils.js";
import { isRecord } from "../../utils.js";
import { resolveSessionAgentId } from "../agent-scope.js";
import {
  bindCronManagementGrant,
  bindCronRequesterGrant,
} from "../cron-creator-authority-context.js";
import { CRON_TOOL_DISPLAY_SUMMARY } from "../tool-description-presets.js";
import { setToolTerminalPresentation } from "../tool-terminal-presentation.js";
import { AUTOMATIONS_TOOL_NAME } from "./automations-tool-name.js";
import {
  type AnyAgentTool,
  jsonResult,
  readNonNegativeIntegerParam,
  readPositiveIntegerParam,
  readToolStringParam,
} from "./common.js";
import {
  canonicalizeCronToolObject,
  hasCronCreateSignal,
  isEmptyRecoveredCronPatch,
  recoverCronObjectFromFlatParams,
  stripCronCreateNullClears,
} from "./cron-tool-canonicalize.js";
import {
  buildReminderContextLines,
  REMINDER_CONTEXT_MARKER,
  stripExistingContext,
} from "./cron-tool-context.js";
import {
  assertInheritedCronToolCaptureReady,
  capCronJobToolsAllowOnCreate,
  cronCreateRequiresCreatorAuthority,
  resolveCronCreatorExecToolTarget,
} from "./cron-tool-creator-cap.js";
import { CronToolOutputSchema } from "./cron-tool-output-schema.js";
import {
  buildCronSelfDescription,
  buildCronToolDescription,
  formatCronTerminalPresentation,
} from "./cron-tool-presentation.js";
import {
  assertCronPacingInput,
  createCronToolSchema,
  CRON_TOOL_LIST_MAX_LIMIT,
} from "./cron-tool-schema.js";
import { listCronSelfJob } from "./cron-tool-self-list.js";
import {
  assertCronCreatorAuthorityResolutionAvailable,
  assertNoCronShellExecution,
  updateCronJobFromAgentTool,
} from "./cron-tool-write.js";
import type {
  CronCreatorToolAuthoritySnapshot,
  CronToolDeps,
  CronToolOptions,
} from "./cron-tool.types.js";
import {
  getGatewayToolCallerIdentity,
  withGatewayToolCallerIdentity,
} from "./gateway-caller-context.js";
import { callGatewayTool, readGatewayCallOptions, type GatewayCallOptions } from "./gateway.js";
import { resolveInternalSessionKey, resolveMainSessionAlias } from "./sessions-helpers.js";

export type { CronCreatorToolAllowlistEntry, CronToolsAllowCaptureRef } from "./cron-tool.types.js";
export {
  captureFinalEffectiveCronCreatorToolAllowlist,
  replaceWithEffectiveCronCreatorToolAllowlist,
} from "./cron-tool-creator-cap.js";

function readCronToolJob(params: Record<string, unknown>, action: "add" | "update") {
  let recovered = false;
  // Models sometimes flatten job fields beside action; create requires a schedule/payload signal.
  if (!params.job || (isRecord(params.job) && Object.keys(params.job).length === 0)) {
    const synthetic = recoverCronObjectFromFlatParams(params);
    if (synthetic.found && (action === "update" || hasCronCreateSignal(synthetic.value))) {
      params.job = synthetic.value;
      recovered = true;
    }
  }
  if (!params.job || typeof params.job !== "object") {
    throw new Error("job required");
  }
  return {
    job: canonicalizeCronToolObject(params.job as Record<string, unknown>),
    recovered,
  };
}

function readCronJobIdParam(params: Record<string, unknown>) {
  return readToolStringParam(params, "jobId") ?? readToolStringParam(params, "id");
}

function requireCronJobIdParam(params: Record<string, unknown>): string {
  const id = readCronJobIdParam(params);
  if (!id) {
    throw new Error("jobId required (id accepted for backward compatibility)");
  }
  return id;
}

const CRON_SELF_REMOVE_SCOPE_ERROR = "Automations tool is restricted to the current automation.";

// A run waits for its outcome up to the call's timeoutMs, capped so one tool call cannot
// hold the turn indefinitely; enqueue keeps its own budget on top of the wait.
const CRON_RUN_MAX_WAIT_MS = 10 * 60_000;
const CRON_RUN_ENQUEUE_TIMEOUT_MS = 60_000;

function readCronSelfRemoveOnlyJobId(opts: CronToolOptions | undefined) {
  return opts?.selfRemoveOnlyJobId?.trim() || undefined;
}

function assertCronSelfRemoveScope(
  opts: CronToolOptions | undefined,
  action: string,
  params: Record<string, unknown>,
) {
  const selfRemoveOnlyJobId = readCronSelfRemoveOnlyJobId(opts);
  if (!selfRemoveOnlyJobId || action === "status" || action === "list") {
    return;
  }
  const selfTargeted = ["next_check", "scratch_get", "scratch_set", "record_result"].includes(
    action,
  );
  if (selfTargeted || ["get", "remove", "runs"].includes(action)) {
    const id = readCronJobIdParam(params);
    if (id === selfRemoveOnlyJobId || (selfTargeted && !id)) {
      return;
    }
  }
  throw new Error(CRON_SELF_REMOVE_SCOPE_ERROR);
}

function isOlderGatewayRejectingParam(error: unknown, method: string, param: string): boolean {
  return (
    error instanceof GatewayClientRequestError &&
    error.gatewayCode === "INVALID_REQUEST" &&
    error.message.includes(`invalid ${method} params`) &&
    error.message.includes(`unexpected property '${param}'`)
  );
}

export function createCronTool(opts?: CronToolOptions, deps?: CronToolDeps): AnyAgentTool {
  const gatewayCall = deps?.callGatewayTool ?? callGatewayTool;
  const managementAuthority = bindCronManagementGrant(opts?.runId);
  const requesterAuthority = bindCronRequesterGrant(opts?.runId);
  const selfJobId = readCronSelfRemoveOnlyJobId(opts);
  const assertCurrentRun =
    opts?.runId && selfJobId ? createAutomationRunGuard(opts.runId, selfJobId) : undefined;
  const automationRun =
    opts?.runId && selfJobId
      ? getAgentRunContext(opts.runId)?.cronRunsByJobId?.get(selfJobId)
      : undefined;
  const activeRun = Boolean(automationRun?.assertCurrent && !automationRun.closed);
  const pacingEnabled = Boolean(activeRun && automationRun?.pacingEnabled);
  const recordResult =
    opts?.runId && selfJobId ? createAutomationResultRecorder(opts.runId, selfJobId) : undefined;
  // Trigger-gated surfaces default on, matching cron/service/jobs-validation.ts.
  const triggersEnabled = opts?.config?.cron?.triggers?.enabled !== false;
  const selfRemoveOnly = Boolean(readCronSelfRemoveOnlyJobId(opts));
  const tool: AnyAgentTool = {
    label: "Automations",
    name: AUTOMATIONS_TOOL_NAME,
    displaySummary: CRON_TOOL_DISPLAY_SUMMARY,
    description: selfRemoveOnly
      ? managementAuthority?.managementOnly
        ? "Inspect or remove only the current automation. Actions: list [includeDisabled], get jobId, remove jobId. Use the current job ID; other jobs and management actions are unavailable."
        : buildCronSelfDescription({ activeRun, pacingEnabled })
      : managementAuthority?.managementOnly
        ? 'Manage any existing automation on this Gateway with the admitted automation management authority. Actions: list [includeDisabled,limit,offset] (compact summaries with timing; follow nextOffset); get jobId (full schedule, payload, and delivery details); update jobId job (partial patch, null clears); run jobId (runMode:"force" runs now; waits up to timeoutMs, default 60s, and returns the finished run, or its runId if still running); remove jobId (operator removal requests cancellation of an active run; the result reports activeRunCancellationRequested:true). Creator attribution and scheduled execution policy stay intact. Use the Automations page for other actions.'
        : buildCronToolDescription({ triggersEnabled }),
    outputSchema: CronToolOutputSchema,
    parameters: createCronToolSchema({
      agentSessionKey: opts?.agentSessionKey,
      triggersEnabled,
      selfRemoveOnly,
      activeRun,
      pacingEnabled,
      management: managementAuthority
        ? managementAuthority.managementOnly
          ? "only"
          : "also"
        : undefined,
    }),
    execute: async (_toolCallId, args, operationSignal) => {
      operationSignal?.throwIfAborted();
      assertCurrentRun?.();
      const callGateway: typeof callGatewayTool = async <T>(
        ...request: Parameters<typeof callGatewayTool>
      ) => {
        operationSignal?.throwIfAborted();
        assertCurrentRun?.();
        const identity = getGatewayToolCallerIdentity();
        const grant = managementAuthority?.mint(request[0], operationSignal);
        const requesterGrant =
          !grant &&
          !identity?.cronCreatorAuthorityGrant &&
          (request[0] === "cron.add" || request[0] === "cron.update")
            ? (requesterAuthority ?? identity?.mintCronRequesterGrant)?.(operationSignal)
            : undefined;
        if ((grant || requesterGrant) && !identity) {
          throw new Error(
            "Automation management requires the active configured channel owner or Control UI administrator turn.",
          );
        }
        const result =
          (grant || requesterGrant) && identity
            ? await withGatewayToolCallerIdentity(
                {
                  ...identity,
                  ...(grant ? { cronManagementGrant: grant } : {}),
                  ...(requesterGrant ? { cronCreatorAuthorityGrant: requesterGrant } : {}),
                },
                () => gatewayCall<T>(...request),
              )
            : await gatewayCall<T>(...request);
        operationSignal?.throwIfAborted();
        assertCurrentRun?.();
        return result;
      };
      const params = args as Record<string, unknown>;
      const action = readToolStringParam(params, "action", { required: true });
      if (
        managementAuthority?.managementOnly &&
        !CRON_MANAGEMENT_METHODS.some((method) => method === `cron.${action}`)
      ) {
        throw new Error(
          "This turn can only list, get, update, run, or remove automations. Use the Automations page for other actions.",
        );
      }
      assertCronSelfRemoveScope(opts, action, params);
      const parsedGatewayOpts = readGatewayCallOptions(params);
      const gatewayOpts: GatewayCallOptions = {
        ...parsedGatewayOpts,
        timeoutMs: parsedGatewayOpts.timeoutMs ?? 60_000,
      };
      const runtimeConfig = getRuntimeConfig();
      const callerAgentId = opts?.agentSessionKey?.trim()
        ? resolveSessionAgentId({
            sessionKey: opts.agentSessionKey,
            config: runtimeConfig,
            agentId: opts.agentId,
          })
        : undefined;
      const creatorExecToolTarget = resolveCronCreatorExecToolTarget(opts?.creatorToolAllowlist);
      const callerIdentity =
        callerAgentId && opts?.agentSessionKey?.trim()
          ? {
              agentId: callerAgentId,
              sessionKey: opts.agentSessionKey.trim(),
              turnSourceAccountId: opts.agentAccountId,
              ...(readCronSelfRemoveOnlyJobId(opts)
                ? { cronSelfManagementJobId: readCronSelfRemoveOnlyJobId(opts) }
                : {}),
              ...(opts?.creatorToolAllowlistCaptureRef?.value?.version === 1 &&
              opts.creatorToolAllowlistCaptureRef.value.source === "final-executable-surface"
                ? {
                    cronToolsAllowCapture: "final-executable-surface" as const,
                    ...(creatorExecToolTarget ? { cronExecToolTarget: creatorExecToolTarget } : {}),
                  }
                : {}),
            }
          : undefined;

      const withCreatorAuthorityProvenance = async <T>(
        authority: CronCreatorToolAuthoritySnapshot | undefined,
        run: () => Promise<T>,
      ): Promise<T> => {
        if (!authority) {
          return await run();
        }
        if (!callerIdentity) {
          throw new Error(
            "fresh configured MCP cron authority requires an authenticated local agent run",
          );
        }
        const cronExecToolTarget = resolveCronCreatorExecToolTarget(authority.tools);
        return await withGatewayToolCallerIdentity(
          {
            ...callerIdentity,
            cronToolsAllowCapture: "final-executable-surface",
            ...(cronExecToolTarget ? { cronExecToolTarget } : {}),
            cronCreatorAuthorityGrant: authority.grant,
          },
          run,
        );
      };

      return await withGatewayToolCallerIdentity(callerIdentity, async () => {
        switch (action) {
          case "status": {
            const result = await callGateway("cron.status", gatewayOpts, {});
            return jsonResult(
              readCronSelfRemoveOnlyJobId(opts)
                ? { enabled: isRecord(result) && result.enabled === true }
                : result,
            );
          }
          case "list": {
            const selfRemoveOnlyJobId = readCronSelfRemoveOnlyJobId(opts);
            const listAgentId = readToolStringParam(params, "agentId");
            const includeDisabled = Boolean(params.includeDisabled);
            const requestedLimit = selfRemoveOnlyJobId
              ? undefined
              : readPositiveIntegerParam(params, "limit", {
                  max: CRON_TOOL_LIST_MAX_LIMIT,
                  message: `limit must be a positive integer no greater than ${CRON_TOOL_LIST_MAX_LIMIT}`,
                });
            const requestedOffset = selfRemoveOnlyJobId
              ? undefined
              : readNonNegativeIntegerParam(params, "offset");
            let useCompactList = true;
            const requestListPage = async (pageParams: Record<string, unknown>) => {
              for (;;) {
                try {
                  return await callGateway("cron.list", gatewayOpts, {
                    includeDisabled,
                    ...(useCompactList ? { compact: true } : {}),
                    ...(listAgentId ? { agentId: listAgentId } : {}),
                    ...pageParams,
                  });
                } catch (error) {
                  if (
                    !useCompactList ||
                    !isOlderGatewayRejectingParam(error, "cron.list", "compact")
                  ) {
                    throw error;
                  }
                  // Protocol v4 gateways predating compact reject the additive field.
                  // Retry without it for mixed-version correctness; remove at the next protocol break.
                  useCompactList = false;
                }
              }
            };
            if (!selfRemoveOnlyJobId) {
              const result = await requestListPage({
                ...(requestedLimit !== undefined ? { limit: requestedLimit } : {}),
                ...(requestedOffset !== undefined ? { offset: requestedOffset } : {}),
              });
              return jsonResult({
                ...result,
                scope: managementAuthority ? "gateway" : "caller",
                ...(!managementAuthority
                  ? {
                      scopeHint:
                        "Restricted automation inventory. For Gateway-wide management, use a fresh authenticated configured channel owner or Control UI administrator turn or the Automations page.",
                    }
                  : {}),
              });
            }

            return jsonResult(
              await listCronSelfJob({
                jobId: selfRemoveOnlyJobId,
                pageSize: CRON_TOOL_LIST_MAX_LIMIT,
                requestPage: requestListPage,
              }),
            );
          }
          case "get":
          case "remove":
          case "runs": {
            const id = requireCronJobIdParam(params);
            const runId = action === "runs" ? readToolStringParam(params, "runId") : undefined;
            return jsonResult(
              await callGateway(`cron.${action}`, gatewayOpts, {
                id,
                ...(runId ? { runId } : {}),
              }),
            );
          }
          case "add": {
            const canonicalJob = stripCronCreateNullClears(readCronToolJob(params, "add").job);
            assertNoCronShellExecution(canonicalJob);
            assertCronDeliveryInputNonBlankFields(canonicalJob.delivery);
            assertCronPacingInput(canonicalJob.pacing);
            for (const key of ["declarationKey", "displayName"]) {
              const value = canonicalJob[key];
              if (typeof value === "string" && value.trim().length === 0) {
                throw new Error(`${key} must be a non-empty string`);
              }
            }
            const enabledExplicit = typeof canonicalJob.enabled === "boolean";
            const job =
              normalizeCronJobCreate(canonicalJob, {
                sessionContext: { sessionKey: opts?.agentSessionKey },
              }) ?? canonicalJob;
            if (
              typeof job.declarationKey === "string" &&
              job.declarationKey.length > 0 &&
              !enabledExplicit
            ) {
              delete job.enabled;
            }
            const requiresCreatorAuthority = cronCreateRequiresCreatorAuthority(
              job,
              opts?.creatorToolAllowlist,
            );
            assertCronCreatorAuthorityResolutionAvailable({
              required: requiresCreatorAuthority,
              resolveCreatorToolAuthority: opts?.resolveCreatorToolAuthority,
              creatorToolAllowlistCaptureRef: opts?.creatorToolAllowlistCaptureRef,
              unavailableReason: opts?.creatorAuthorityUnavailableReason,
            });
            const resolvedAuthority =
              requiresCreatorAuthority && opts?.resolveCreatorToolAuthority
                ? await opts.resolveCreatorToolAuthority({ signal: operationSignal })
                : undefined;
            operationSignal?.throwIfAborted();
            const creatorToolAllowlist = resolvedAuthority?.tools ?? opts?.creatorToolAllowlist;
            const creatorToolAllowlistCaptureRef = resolvedAuthority
              ? { value: resolvedAuthority.provenance }
              : opts?.creatorToolAllowlistCaptureRef;
            capCronJobToolsAllowOnCreate(
              job,
              creatorToolAllowlist,
              resolvedAuthority?.holdsRuntimeAuthority,
            );
            assertInheritedCronToolCaptureReady(job, creatorToolAllowlistCaptureRef);
            const { alias } = resolveMainSessionAlias(runtimeConfig);
            const resolvedSessionKey = opts?.agentSessionKey
              ? resolveInternalSessionKey({ key: opts.agentSessionKey, alias })
              : undefined;
            const sessionTarget = normalizeLowercaseStringOrEmpty(job.sessionTarget);
            if (!("sessionKey" in job) && resolvedSessionKey && sessionTarget !== "isolated") {
              job.sessionKey = resolvedSessionKey;
            }

            if (
              (opts?.agentSessionKey || opts?.currentDeliveryContext) &&
              "payload" in job &&
              (job as { payload?: { kind?: string } }).payload?.kind === "agentTurn"
            ) {
              const deliveryValue = job.delivery;
              const delivery = isRecord(deliveryValue) ? deliveryValue : undefined;
              const modeRaw = typeof delivery?.mode === "string" ? delivery.mode : "";
              const mode = normalizeLowercaseStringOrEmpty(modeRaw);
              if (mode === "webhook") {
                const webhookUrl = normalizeHttpWebhookUrl(delivery?.to);
                if (!webhookUrl) {
                  throw new Error(
                    'delivery.mode="webhook" requires delivery.to to be a valid http(s) URL',
                  );
                }
                if (delivery) {
                  delivery.to = webhookUrl;
                }
              }

              const hasTarget =
                (typeof delivery?.channel === "string" && delivery.channel.trim()) ||
                (typeof delivery?.to === "string" && delivery.to.trim());
              const shouldInfer =
                (deliveryValue == null || delivery) &&
                (mode === "" || mode === "announce") &&
                !hasTarget &&
                delivery?.target !== "owner";
              if (shouldInfer) {
                const inferred = await resolveCronCreationDelivery({
                  cfg: runtimeConfig,
                  currentDeliveryContext: opts.currentDeliveryContext,
                  agentSessionKey: opts.agentSessionKey,
                });
                if (inferred) {
                  job.delivery = {
                    ...inferred,
                    ...delivery,
                  } satisfies CronDelivery;
                }
              }
            }

            const contextMessages = readNonNegativeIntegerParam(params, "contextMessages") ?? 0;
            if (
              "payload" in job &&
              (job as { payload?: { kind?: string; text?: string } }).payload?.kind ===
                "systemEvent"
            ) {
              const payload = (job as { payload: { kind: string; text: string } }).payload;
              if (typeof payload.text === "string" && payload.text.trim()) {
                const contextLines = await buildReminderContextLines({
                  agentSessionKey: opts?.agentSessionKey,
                  agentId: callerAgentId,
                  gatewayOpts,
                  contextMessages,
                  callGatewayTool: callGateway,
                });
                if (contextLines.length > 0) {
                  const baseText = stripExistingContext(payload.text);
                  payload.text = `${baseText}${REMINDER_CONTEXT_MARKER}${contextLines.join("\n")}`;
                }
              }
            }
            return jsonResult(
              await withCreatorAuthorityProvenance(resolvedAuthority, () =>
                callGateway("cron.add", gatewayOpts, job),
              ),
            );
          }
          case "update": {
            const id = requireCronJobIdParam(params);

            const { job: canonicalPatch, recovered: recoveredFlatPatch } = readCronToolJob(
              params,
              "update",
            );
            if (!managementAuthority) {
              assertNoCronShellExecution(canonicalPatch);
            }
            assertCronDeliveryInputNonBlankFields(canonicalPatch.delivery);
            assertCronPacingInput(canonicalPatch.pacing);
            if (
              typeof canonicalPatch.displayName === "string" &&
              canonicalPatch.displayName.trim().length === 0
            ) {
              throw new Error("displayName must be a non-empty string or null");
            }
            const patch = normalizeCronJobPatch(canonicalPatch) ?? canonicalPatch;
            if (recoveredFlatPatch && isEmptyRecoveredCronPatch(patch)) {
              throw new Error("job required");
            }
            // Admin patches still need stored-payload inference, but must not
            // recapture the creator's execution authority.
            const creatorOptions = managementAuthority ? undefined : opts;
            return jsonResult(
              await updateCronJobFromAgentTool({
                id,
                patch,
                adminManagement: Boolean(managementAuthority),
                creatorToolAllowlist: creatorOptions?.creatorToolAllowlist,
                creatorToolAllowlistCaptureRef: creatorOptions?.creatorToolAllowlistCaptureRef,
                resolveCreatorToolAuthority: creatorOptions?.resolveCreatorToolAuthority,
                withCreatorAuthorityProvenance:
                  !managementAuthority && callerIdentity
                    ? withCreatorAuthorityProvenance
                    : undefined,
                gatewayOpts,
                callGateway,
                operationSignal,
                creatorAuthorityUnavailableReason:
                  creatorOptions?.creatorAuthorityUnavailableReason,
              }),
            );
          }
          case "run": {
            const id = requireCronJobIdParam(params);
            const runMode =
              params.runMode === "due" || params.runMode === "force" ? params.runMode : "due";
            // The Gateway holds the request until the run records its outcome, so the model
            // learns the result in this call instead of scheduling a follow-up check.
            const waitTimeoutMs = Math.min(
              parsedGatewayOpts.timeoutMs ?? 60_000,
              CRON_RUN_MAX_WAIT_MS,
            );
            let result: Record<string, unknown>;
            try {
              result = await callGateway(
                "cron.run",
                { ...gatewayOpts, timeoutMs: waitTimeoutMs + CRON_RUN_ENQUEUE_TIMEOUT_MS },
                { id, mode: runMode, waitTimeoutMs },
              );
            } catch (error) {
              // Shipped Gateways reject the param before enqueueing, so retrying cannot double-run.
              if (!isOlderGatewayRejectingParam(error, "cron.run", "waitTimeoutMs")) {
                throw error;
              }
              result = await callGateway("cron.run", gatewayOpts, { id, mode: runMode });
            }
            if (result.enqueued !== true || result.run) {
              return jsonResult(result);
            }
            const followUp = managementAuthority?.managementOnly
              ? "check it later on the Automations page"
              : "check it later with runs jobId runId";
            return jsonResult({
              ...result,
              note: result.finished
                ? `Finished, but its run history is not visible to this turn (a one-shot may have deleted itself after succeeding); ${followUp} if needed.`
                : `Not finished yet: it is still running, or it runs in this session and starts after this turn. Its delivery follows the job settings; ${followUp}. Do not schedule a verification job.`,
            });
          }
          case "scratch_get":
          case "scratch_set": {
            if (!selfJobId || !assertCurrentRun) {
              throw new Error(
                "scratch actions are only available inside the currently running automation; use the automation editor for other jobs",
              );
            }
            if (action === "scratch_get") {
              return jsonResult(
                await callGateway("cron.scratch.get", gatewayOpts, { id: selfJobId }),
              );
            }
            if (typeof params.content !== "string" && params.content !== null) {
              throw new Error("scratch_set requires complete content or null to clear");
            }
            const expectedRevision = readNonNegativeIntegerParam(params, "expectedRevision");
            if (expectedRevision === undefined) {
              throw new Error("scratch_set requires expectedRevision from scratch_get");
            }
            return jsonResult(
              await callGateway("cron.scratch.set", gatewayOpts, {
                id: selfJobId,
                content: params.content,
                expectedRevision,
              }),
            );
          }
          case "record_result": {
            if (!selfJobId || !recordResult) {
              throw new Error(
                "record_result is only available inside the currently running automation",
              );
            }
            const outcome = params.outcome;
            if (
              outcome !== "no_change" &&
              outcome !== "progress" &&
              outcome !== "done" &&
              outcome !== "blocked" &&
              outcome !== "needs_attention"
            ) {
              throw new Error(
                "record_result requires no_change, progress, done, blocked, or needs_attention",
              );
            }
            const summary = readToolStringParam(params, "summary", { required: true });
            recordResult({ outcome, summary });
            return jsonResult({ ok: true, outcome, summary });
          }
          case "next_check": {
            const jobId = readCronSelfRemoveOnlyJobId(opts);
            const runId = opts?.runId?.trim();
            if (!jobId || !runId) {
              throw new Error("cron next_check is only available to the currently running job");
            }
            const rawDuration = readToolStringParam(params, "in", { required: true });
            let delayMs: number;
            try {
              delayMs = parseDurationMs(rawDuration);
            } catch {
              throw new Error("cron next_check in must be a positive duration");
            }
            if (delayMs <= 0) {
              throw new Error("cron next_check in must be a positive duration");
            }
            recordCronNextCheckProposal(runId, jobId, delayMs);
            return jsonResult({ ok: true, delayMs });
          }
          case "wake": {
            const text = readToolStringParam(params, "text", { required: true });
            // Gateway owns target validation and ordinary session queue admission.
            const { alias } = resolveMainSessionAlias(runtimeConfig);
            const explicitSessionKey = readToolStringParam(params, "sessionKey");
            const explicitAgentId = readToolStringParam(params, "agentId");
            const inferredSessionKey = opts?.agentSessionKey
              ? resolveInternalSessionKey({ key: opts.agentSessionKey, alias })
              : undefined;
            const sessionKey = explicitSessionKey ?? inferredSessionKey;
            // Pair an explicit session with its own agent; caller defaults must
            // not rewrite that target before the Gateway can validate it.
            const agentIdFromExplicitSessionKey = explicitSessionKey
              ? parseAgentSessionKey(explicitSessionKey)?.agentId
              : undefined;
            const agentId =
              explicitAgentId ??
              (explicitSessionKey ? agentIdFromExplicitSessionKey : callerAgentId);
            return jsonResult(
              await callGateway(
                "wake",
                gatewayOpts,
                {
                  mode: "now",
                  text,
                  ...(sessionKey ? { sessionKey } : {}),
                  ...(agentId ? { agentId } : {}),
                },
                { expectFinal: false },
              ),
            );
          }
          default:
            throw new Error(`Unknown action: ${action}`);
        }
      });
    },
  };
  return setToolTerminalPresentation(tool, formatCronTerminalPresentation);
}
