import { normalizeLowercaseStringOrEmpty } from "@openclaw/normalization-core/string-coerce";
import { getRuntimeConfig } from "../../config/config.js";
import { getRuntimeConfigSnapshot } from "../../config/runtime-snapshot.js";
import { resolveCronCreationDelivery } from "../../cron/delivery-context.js";
import { assertCronDeliveryInputNonBlankFields } from "../../cron/delivery-target-validation.js";
import { normalizeCronJobCreate, normalizeCronJobPatch } from "../../cron/normalize.js";
import { readCronStreamApprovalEnded } from "../../cron/stream-approval-outcome.js";
import {
  cronCreateRequiresStreamExecAuthority,
  type CronStreamExecPolicy,
  type CronStreamExecApprovalReceipt,
} from "../../cron/stream-exec-authority.js";
import type { CronDelivery, CronJob } from "../../cron/types.js";
import { normalizeHttpWebhookUrl } from "../../cron/webhook-url.js";
import { GatewayClientRequestError } from "../../gateway/client.js";
import {
  CRON_MANAGEMENT_METHODS,
  isCronModelManagementAllowed,
} from "../../gateway/cron-creator-authority-grant.js";
import { DEFAULT_EXEC_APPROVAL_TIMEOUT_MS } from "../../infra/exec-approvals-core.js";
import { normalizeAccountId } from "../../routing/account-id.js";
import { parseAgentSessionKey } from "../../sessions/session-key-utils.js";
import { isRecord } from "../../utils.js";
import { resolveSessionAgentId } from "../agent-scope.js";
import {
  bindCronManagementGrant,
  bindCronRequesterGrant,
} from "../cron-creator-authority-context.js";
import { CRON_TOOL_DISPLAY_SUMMARY } from "../tool-description-presets.js";
import { withToolEffectBoundary } from "../tool-effect-receipt.js";
import { bindAgentToolReplaySafety } from "../tool-replay-safety.js";
import { setToolTerminalPresentation } from "../tool-terminal-presentation.js";
import { AUTOMATIONS_TOOL_NAME, CRON_SCOPED_READ_ACTIONS } from "./automations-tool-name.js";
import {
  type AnyAgentTool,
  jsonResult,
  readNonNegativeIntegerParam,
  readPositiveIntegerParam,
  readToolStringParam,
} from "./common.js";
import { createCronAutomationActions } from "./cron-tool-automation.js";
import {
  isEmptyRecoveredCronPatch,
  prepareCronToolArguments,
  readCronToolJob,
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
import { buildCronToolDescription } from "./cron-tool-description.js";
import { createCronToolGatewayCaller } from "./cron-tool-gateway.js";
import { CronToolOutputSchema } from "./cron-tool-output-schema.js";
import { formatCronTerminalPresentation } from "./cron-tool-presentation.js";
import {
  assertCronPacingInput,
  createCronToolSchema,
  CRON_TOOL_LIST_MAX_LIMIT,
} from "./cron-tool-schema.js";
import { listCronSelfJob } from "./cron-tool-self-list.js";
import {
  assertCronCreatorAuthorityResolutionAvailable,
  assertNoCronShellExecution,
  prepareCronStreamExecPolicy,
  captureCronStreamPolicyConfigCurrentness,
  updateCronJobFromAgentTool,
} from "./cron-tool-write.js";
import type {
  CronCreatorToolAllowlistEntry,
  CronCreatorToolAuthoritySnapshot,
  CronToolOptions,
} from "./cron-tool.types.js";
import {
  getGatewayToolCallerIdentity,
  withGatewayToolCallerIdentity,
} from "./gateway-caller-context.js";
import { readGatewayCallOptions, type GatewayCallOptions } from "./gateway.js";
import { resolveInternalSessionKey, resolveMainSessionAlias } from "./sessions-helpers.js";

export type { CronCreatorToolAllowlistEntry, CronToolsAllowCaptureRef } from "./cron-tool.types.js";
export {
  captureFinalEffectiveCronCreatorToolAllowlist,
  replaceWithEffectiveCronCreatorToolAllowlist,
} from "./cron-tool-creator-cap.js";

function requireCronJobIdParam(params: Record<string, unknown>): string {
  const id = readToolStringParam(params, "jobId") ?? readToolStringParam(params, "id");
  if (!id) {
    throw new Error("jobId required (id accepted for backward compatibility)");
  }
  return id;
}

const CRON_RUN_MAX_WAIT_MS = 10 * 60_000;
const CRON_RUN_ENQUEUE_TIMEOUT_MS = 60_000;

const CRON_SELF_REMOVE_SCOPE_ERROR = "Automations tool is restricted to the current automation.";

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
  const invocationAction = ["next_check", "scratch_get", "scratch_set", "record_result"].includes(
    action,
  );
  if (invocationAction || ["get", "remove", "runs"].includes(action)) {
    const id = readToolStringParam(params, "jobId") ?? readToolStringParam(params, "id");
    if (id === selfRemoveOnlyJobId || (invocationAction && !id)) {
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

export function createCronTool(opts?: CronToolOptions): AnyAgentTool {
  const config = opts?.config ?? getRuntimeConfigSnapshot() ?? undefined;
  const readOnly = opts?.readOnly === true;
  const assertStreamConfigCurrent = captureCronStreamPolicyConfigCurrentness(opts);
  const managementAuthority = bindCronManagementGrant(opts?.runId, config);
  const requesterAuthority = bindCronRequesterGrant(opts?.runId);
  const allowCommandJobs = config?.tools?.gatewayPolicy?.automations?.allowCommandJobs !== false;
  const automation = createCronAutomationActions(opts);
  const { activeRun, nextCheckEnabled, assertCurrent: assertCurrentRun } = automation;
  // Trigger-gated surfaces default on, matching cron/service/jobs-validation.ts.
  const triggersEnabled = opts?.config?.cron?.triggers?.enabled !== false;
  const selfRemoveOnly = Boolean(readCronSelfRemoveOnlyJobId(opts));
  const tool: AnyAgentTool = {
    label: "Automations",
    name: AUTOMATIONS_TOOL_NAME,
    displaySummary: readOnly ? "Inspect recorded automation state." : CRON_TOOL_DISPLAY_SUMMARY,
    description: buildCronToolDescription({
      triggersEnabled,
      callerScoped: !isCronModelManagementAllowed(config),
      readOnly,
      selfRemoveOnly,
      activeRun,
      nextCheckEnabled,
      managementOnly: managementAuthority?.managementOnly,
      allowCommandJobs,
    }),
    outputSchema: CronToolOutputSchema,
    parameters: createCronToolSchema({
      readOnly,
      allowCommandJobs,
      agentSessionKey: opts?.agentSessionKey,
      triggersEnabled,
      selfRemoveOnly,
      activeRun,
      nextCheckEnabled,
      management: managementAuthority && (managementAuthority.managementOnly ? "only" : "also"),
    }),
    prepareArguments: prepareCronToolArguments,
    execute: async (_toolCallId, args, operationSignal) => {
      operationSignal?.throwIfAborted();
      assertCurrentRun?.();
      let streamExecPolicy: CronStreamExecPolicy | undefined;
      let streamExecutionApproval: CronStreamExecApprovalReceipt | undefined;
      const mutationResult = (result: unknown) =>
        jsonResult(
          streamExecutionApproval && isRecord(result)
            ? {
                ...result,
                streamExecutionApproval: {
                  ...streamExecutionApproval,
                  message:
                    "A human operator approved this watcher and its automatic restarts. The approver's identity is not supplied.",
                },
              }
            : result,
        );
      const params = args as Record<string, unknown>;
      const action = readToolStringParam(params, "action", { required: true });
      if (readOnly && !CRON_SCOPED_READ_ACTIONS.includes(action)) {
        throw new Error(
          "The automation tool is read-only during recovery; only caller-scoped inspections are available. It cannot create, change, remove, run, or wake work. This restriction does not establish the outcome of an earlier action.",
        );
      }
      if (
        managementAuthority?.managementOnly &&
        !CRON_MANAGEMENT_METHODS.some((method) => method === `cron.${action}`)
      ) {
        throw new Error(
          "This turn can only list, get, update, run, remove, or bind automations. Use the Automations page for other actions.",
        );
      }
      assertCronSelfRemoveScope(opts, action, params);
      const parsedGatewayOpts = readGatewayCallOptions(params);
      const gatewayOpts: GatewayCallOptions = {
        ...parsedGatewayOpts,
        timeoutMs:
          parsedGatewayOpts.timeoutMs ??
          (action === "add" || action === "update"
            ? DEFAULT_EXEC_APPROVAL_TIMEOUT_MS + 10_000
            : 60_000),
      };
      const runtimeConfig = getRuntimeConfig();
      const { alias } = resolveMainSessionAlias(runtimeConfig);
      const callerSessionKey = opts?.agentSessionKey
        ? resolveInternalSessionKey({ key: opts.agentSessionKey, alias })
        : undefined;
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
              ...(assertCurrentRun ? { receiptAuthority: assertCurrentRun } : {}),
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

      const executeAction = async (onEffectsStart?: () => void) => {
        const prepareStreamExecAuthority = async (
          creatorTools: readonly CronCreatorToolAllowlistEntry[] | undefined,
        ) => {
          onEffectsStart?.();
          streamExecPolicy = await prepareCronStreamExecPolicy({
            opts,
            creatorTools,
            operationSignal,
            assertConfigCurrent: assertStreamConfigCurrent,
          });
          streamExecPolicy.onApprovalCommitted = (receipt) => {
            streamExecutionApproval = receipt;
          };
        };
        const callGateway = createCronToolGatewayCaller({
          managementAuthority,
          requesterAuthority,
          operationSignal,
          readStreamExecPolicy: () => streamExecPolicy,
          assertCurrent: assertCurrentRun,
          onEffectsStart,
        });
        const readTargetRevision = async (id: string) => {
          if (
            !getGatewayToolCallerIdentity()?.sessionKey ||
            readCronSelfRemoveOnlyJobId(opts) === id
          ) {
            return undefined;
          }
          const target = await callGateway("cron.get", gatewayOpts, { id });
          operationSignal?.throwIfAborted();
          if (getGatewayToolCallerIdentity()?.receiptAuthority?.() === false) {
            throw new Error("The requesting turn is no longer active.");
          }
          if (!isRecord(target) || typeof target.configRevision !== "string") {
            throw new Error(
              "Automation target has no current revision. Inspect it again before retrying.",
            );
          }
          // Pin the observed definition across preparation; the mutation owner
          // rejects a later edit instead of applying this request to its successor.
          return target.configRevision;
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
              const result = selfRemoveOnlyJobId
                ? await listCronSelfJob({
                    jobId: selfRemoveOnlyJobId,
                    pageSize: CRON_TOOL_LIST_MAX_LIMIT,
                    requestPage: requestListPage,
                  })
                : await requestListPage({
                    ...(requestedLimit !== undefined ? { limit: requestedLimit } : {}),
                    ...(requestedOffset !== undefined ? { offset: requestedOffset } : {}),
                  });
              if (!isRecord(result)) {
                throw new Error("cron.list returned an invalid inventory response");
              }
              return jsonResult({
                ...result,
                includeDisabled,
                inventoryHint: `${includeDisabled ? "Enabled and disabled automations are included." : "Disabled automations are omitted."} Counts and pagination describe this filtered view. Absence does not prove deletion or source termination. For a known watcher, use get jobId to inspect its saved state and streamStatus.`,
                ...(!selfRemoveOnlyJobId
                  ? {
                      scope: managementAuthority ? "gateway" : "caller",
                      ...(!managementAuthority
                        ? {
                            scopeHint:
                              "Restricted automation inventory. For Gateway-wide management, use a fresh authenticated configured channel owner or Control UI administrator turn or the Automations page.",
                          }
                        : {}),
                    }
                  : {}),
              });
            }
            case "remove": {
              const id = requireCronJobIdParam(params);
              const expectedConfigRevision = await readTargetRevision(id);
              return jsonResult(
                await callGateway("cron.remove", gatewayOpts, {
                  id,
                  ...(expectedConfigRevision ? { expectedConfigRevision } : {}),
                }),
              );
            }
            case "get":
            case "runs":
            case "bind": {
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
              if (
                typeof canonicalJob.declarationKey === "string" &&
                canonicalJob.declarationKey.trim().length === 0
              ) {
                throw new Error("declarationKey must be a non-empty string");
              }
              if (
                typeof canonicalJob.displayName === "string" &&
                canonicalJob.displayName.trim().length === 0
              ) {
                throw new Error("displayName must be a non-empty string");
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
              if (cronCreateRequiresStreamExecAuthority(job)) {
                await prepareStreamExecAuthority(creatorToolAllowlist);
              }
              capCronJobToolsAllowOnCreate(
                job,
                creatorToolAllowlist,
                resolvedAuthority?.holdsRuntimeAuthority,
              );
              assertInheritedCronToolCaptureReady(job, creatorToolAllowlistCaptureRef);
              const sessionTarget = normalizeLowercaseStringOrEmpty(job.sessionTarget);
              if (!("sessionKey" in job) && callerSessionKey && sessionTarget !== "isolated") {
                job.sessionKey = callerSessionKey;
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
                    agentId: callerAgentId,
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
              return mutationResult(
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
              if (!managementAuthority || !allowCommandJobs) {
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
              let creatorOptions = managementAuthority ? undefined : opts;
              if (
                managementAuthority &&
                opts?.resolveCreatorToolAuthority &&
                isRecord(patch.payload) &&
                Object.hasOwn(patch.payload, "toolsAllow")
              ) {
                const current = await callGateway<CronJob>("cron.get", gatewayOpts, { id });
                if (
                  current.owner?.sessionKey === callerIdentity?.sessionKey &&
                  normalizeAccountId(current.owner?.accountId) ===
                    normalizeAccountId(opts?.agentAccountId)
                ) {
                  // Resolve a fresh owner ceiling even for already-visible tools.
                  creatorOptions = { ...opts, creatorToolAllowlist: undefined };
                }
              }
              const update = async (expectedConfigRevision?: string) =>
                mutationResult(
                  await updateCronJobFromAgentTool({
                    id,
                    expectedConfigRevision,
                    patch,
                    adminManagement: Boolean(managementAuthority) && allowCommandJobs,
                    creatorToolAllowlist: creatorOptions?.creatorToolAllowlist,
                    creatorToolAllowlistCaptureRef: creatorOptions?.creatorToolAllowlistCaptureRef,
                    resolveCreatorToolAuthority: creatorOptions?.resolveCreatorToolAuthority,
                    withCreatorAuthorityProvenance,
                    gatewayOpts,
                    callGateway,
                    operationSignal,
                    creatorAuthorityUnavailableReason:
                      creatorOptions?.creatorAuthorityUnavailableReason,
                    prepareStreamExecAuthority: async (creatorTools) => {
                      // Management edits preserve the target's cap, but a stream still
                      // executes under the caller's own complete executable surface.
                      assertCronCreatorAuthorityResolutionAvailable({
                        required: creatorOptions === undefined,
                        creatorToolAllowlistCaptureRef: opts?.creatorToolAllowlistCaptureRef,
                        unavailableReason: opts?.creatorAuthorityUnavailableReason,
                      });
                      await prepareStreamExecAuthority(creatorTools ?? opts?.creatorToolAllowlist);
                    },
                  }),
                );
              return patch.enabled === false
                ? await update(await readTargetRevision(id))
                : await update();
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
              if (!isRecord(result)) {
                throw new Error("cron.list returned an invalid inventory response");
              }
              return jsonResult({
                ...result,
                note: result.finished
                  ? `Finished, but its run history is not visible to this turn (a one-shot may have deleted itself after succeeding); ${followUp} if needed.`
                  : `Not finished yet: it is still running, or it runs in this session and starts after this turn. Its delivery follows the job settings; ${followUp}. Do not schedule a verification job.`,
              });
            }
            case "scratch_get":
            case "scratch_set":
            case "record_result":
            case "next_check":
              return await automation.execute(action, params, callGateway, gatewayOpts);
            case "wake": {
              const text = readToolStringParam(params, "text", { required: true });
              const mode =
                params.mode === "now" || params.mode === "next-heartbeat"
                  ? params.mode
                  : "next-heartbeat";
              // An omitted target wakes the originating conversation, not the
              // heartbeat lane. Gateway owns target validation and authorization.
              const explicitSessionKey = readToolStringParam(params, "sessionKey");
              const explicitAgentId = readToolStringParam(params, "agentId");
              const sessionKey = explicitSessionKey ?? callerSessionKey;
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
                    mode,
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
        }).catch((error: unknown) => {
          const ended =
            error instanceof GatewayClientRequestError && error.gatewayCode === "FORBIDDEN"
              ? readCronStreamApprovalEnded(error.details)
              : undefined;
          if (ended && ended.action === action) {
            return jsonResult(ended);
          }
          throw error;
        });
      };
      return await (action === "add" || action === "update"
        ? withToolEffectBoundary(executeAction)
        : executeAction());
    },
  };
  if (readOnly) {
    bindAgentToolReplaySafety(tool, "bounded-read");
  }
  return setToolTerminalPresentation(tool, formatCronTerminalPresentation);
}
