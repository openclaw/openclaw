import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import {
  bindOperatorModelExecution,
  type PreparedAgentRunAdmission,
} from "../agents/admitted-run-context.js";
import { resolveAgentDir } from "../agents/agent-scope.js";
import { resolveSessionModelRef } from "../agents/session-model-ref.js";
import {
  createAdmittedGatewayToolCallerIdentity,
  withGatewayToolCallerIdentity,
} from "../agents/tools/gateway-caller-context.js";
import { withRequesterNativeSubagents } from "../auto-reply/reply/request-native-subagent.js";
import { captureSessionEntryCurrentCheckAsyncInternal } from "../config/sessions/session-entry-current-check.js";
import { composeSessionSourceAssertion } from "../config/sessions/session-source-authority.js";
import { resolveSessionStorePathForScope } from "../config/sessions/session-store-path.js";
import { appendAssistantMessageToSessionTranscript } from "../config/sessions/transcript.runtime.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { captureCronJobSourceAuthority } from "../cron/active-jobs.js";
import type { CronInferenceBinding } from "../cron/inference-binding.js";
import {
  acquireCronInferenceAuthorization,
  captureCronInferenceBinding,
} from "../cron/inference-binding.runtime.js";
import {
  decodePluginCommandSchedule,
  resolvePluginCommandScheduleBinding,
} from "../cron/plugin-command-schedule.js";
import {
  PLUGIN_COMMAND_SCHEDULE_MESSAGE,
  type PluginCommandSchedule,
} from "../cron/plugin-command-schedule.types.js";
import { prepareCronRunAdmission } from "../cron/run-admission.js";
import { resolveCronRequesterExecutionRevision } from "../cron/service/jobs-tool-policy.js";
import type { CronServiceDeps } from "../cron/service/state.js";
import type { CronStoredJob } from "../cron/types.js";
import { isAbortError, racePromiseWithAbortSignal } from "../infra/abort-signal.js";
import { formatErrorMessage } from "../infra/errors.js";
import { getPluginInstanceCodeIdentity } from "../plugins/plugin-code-identity.js";
import { pluginCommandSupportsChannel } from "../plugins/plugin-command-metadata.js";
import { listRegisteredPluginCommands } from "../plugins/plugin-command-registry.js";
import * as commandRuntime from "../plugins/plugin-command-runtime.js";
import { getPluginInstanceIncarnation } from "../plugins/plugin-instance-scope.js";
import { isPluginRegistryRetired } from "../plugins/registry-lifecycle.js";
import type { PluginRegistry } from "../plugins/registry-types.js";
import type { PluginCommandResult } from "../plugins/types.js";
import { withSessionTurn } from "../sessions/session-controller.admission.js";
import {
  buildRunUserTurnIdempotencyKey,
  createUserTurnTranscriptRecorder,
} from "../sessions/user-turn-transcript.js";
import { restoreGatewayQueuedOperatorRecovery } from "./operator-run-recovery.js";
import type { GatewayContextResolver } from "./server-methods/types.js";

type ScheduledRequest = Parameters<CronServiceDeps["runIsolatedAgentJob"]>[0];
type ScheduledResult = Awaited<ReturnType<CronServiceDeps["runIsolatedAgentJob"]>>;

/** Host-only dispatch owner contract. It must throw failures, fence every runtime effect,
 * and disable ambient completion/account fallback (or bind completion to this exact account).
 * Ordinary channel dispatch intentionally does not satisfy this stricter contract. */
export type ScheduledPluginCommandDispatch = (
  dispatch: commandRuntime.PluginCommandDispatch,
  context: commandRuntime.PluginCommandDispatchContext & {
    abortSignal: AbortSignal;
    inferenceBinding?: CronInferenceBinding;
  },
) => Promise<PluginCommandResult>;

/** Distinguish the reserved turn before ANY normal agent prompt processing. */
export function readPluginCommandScheduledJob(
  job: CronStoredJob,
): PluginCommandSchedule | undefined {
  const sentinel =
    job.payload.kind === "agentTurn" && job.payload.message === PLUGIN_COMMAND_SCHEDULE_MESSAGE;
  if (job.pluginCommand === undefined && !sentinel) {
    return undefined;
  }
  if (job.pluginCommand === undefined) {
    throw new Error("Scheduled plugin command is missing its private envelope.");
  }
  const schedule = decodePluginCommandSchedule(job.pluginCommand);
  if (
    !sentinel ||
    job.agentId !== schedule.parent.agentId ||
    job.sessionTarget !== "session:" + schedule.parent.sessionKey ||
    !isDeepStrictEqual(job.delivery, { mode: "none" }) ||
    !isDeepStrictEqual(job.sourceConversation, {
      sessionKey: schedule.parent.sessionKey,
      sessionId: schedule.parent.sessionId,
      ...(schedule.parent.lifecycleRevision !== undefined
        ? { lifecycleRevision: schedule.parent.lifecycleRevision }
        : {}),
    }) ||
    job.payload.kind !== "agentTurn" ||
    !Array.isArray(job.payload.toolsAllow) ||
    !job.payload.toolsAllow.every((tool) => schedule.toolsAllow.includes(tool)) ||
    !job.payload.toolsAllow.includes("sessions_spawn") ||
    !job.payload.toolsAllow.includes("agents_wait")
  ) {
    throw new Error(
      "Scheduled plugin command does not match its bound conversation and tool ceiling.",
    );
  }
  return schedule;
}

/** The bound managed plugin instance was replaced in this process; the schedule ends. */
class PluginCommandScheduleInstanceReplacedError extends Error {
  constructor() {
    super("Scheduled plugin command's original plugin instance was replaced; the schedule ended.");
    this.name = "PluginCommandScheduleInstanceReplacedError";
  }
}

/**
 * The live registry, not persisted metadata or a caller-created command object, owns dispatch.
 * `binding` is what the scheduler claim bound: the creating instance, or after a Gateway restart
 * the instance the claim re-armed the schedule onto, which must still run the accepted code.
 */
export function assertPluginCommandScheduleRegistry(
  registry: PluginRegistry,
  schedule: PluginCommandSchedule,
  binding: { pluginIncarnation: string; sourceDigest?: string } = schedule,
): void {
  const { pluginIncarnation } = binding;
  const plugin = registry.plugins.find((record) => record.id === schedule.pluginId);
  const liveIncarnation = plugin && getPluginInstanceIncarnation(plugin);
  if (
    !isPluginRegistryRetired(registry) &&
    liveIncarnation !== undefined &&
    liveIncarnation !== pluginIncarnation
  ) {
    // A current registry already serves another live instance. A transient gap (retired
    // registry, unloading or disposed instance) stays an ordinary refusal: adoption can keep it.
    throw new PluginCommandScheduleInstanceReplacedError();
  }
  const command = listRegisteredPluginCommands(registry).find(
    (entry) => entry.name === schedule.command,
  );
  if (
    isPluginRegistryRetired(registry) ||
    !plugin ||
    getPluginInstanceIncarnation(plugin) !== pluginIncarnation ||
    (binding.sourceDigest !== undefined &&
      getPluginInstanceCodeIdentity(plugin) !== binding.sourceDigest) ||
    plugin.status !== "loaded" ||
    !plugin.enabled ||
    plugin.source !== schedule.pluginSource ||
    plugin.rootDir !== schedule.pluginRoot ||
    plugin.version !== schedule.pluginVersion ||
    !plugin.contracts?.sessionScheduledTurns?.includes("requester-command") ||
    !command ||
    command.pluginId !== plugin.id ||
    command.pluginRoot !== plugin.rootDir ||
    command.requireAuth !== true ||
    !command.runtimeCapabilities?.includes("subagents") ||
    !pluginCommandSupportsChannel(command, schedule.channel)
  ) {
    throw new Error(
      "Scheduled plugin command is no longer available from its original loaded plugin.",
    );
  }
}

/** Runs only an already-claimed native occurrence. No timer, counter, replay owner or LLM fallback. */
export async function runPluginCommandScheduledTurn(params: {
  request: ScheduledRequest;
  cfg: OpenClawConfig;
  agentId: string;
  resolveGatewayContext?: GatewayContextResolver;
  resolvePluginRegistry?: () => PluginRegistry | undefined;
  executeScheduledDispatch?: ScheduledPluginCommandDispatch;
}): Promise<ScheduledResult | undefined> {
  const job: CronStoredJob = params.request.job;
  let executionStarted = false;
  let turnSignal: AbortSignal | undefined;
  try {
    const schedule = readPluginCommandScheduledJob(job);
    if (!schedule) {
      return undefined;
    }
    const { request, cfg } = params;
    if (job.payload.kind !== "agentTurn" || !job.payload.toolsAllow) {
      throw new Error("Scheduled plugin command has no native tool ceiling.");
    }
    const toolsAllow = [...job.payload.toolsAllow];
    const binding = resolvePluginCommandScheduleBinding(job, schedule);
    const context = params.resolveGatewayContext?.();
    const registry = params.resolvePluginRegistry?.();
    const assertOccurrence = captureCronJobSourceAuthority(job.id);
    const fence = request.deliveryAttemptFence;
    if (
      !context ||
      !registry ||
      !assertOccurrence ||
      !fence ||
      params.agentId !== schedule.parent.agentId
    ) {
      throw new Error(
        "Scheduled plugin command requires its live Gateway occurrence and plugin registry.",
      );
    }
    const getConfig = context.getCommittedRuntimeConfig ?? context.getRuntimeConfig;
    const configAtAdmission = getConfig();
    if (!isDeepStrictEqual(configAtAdmission, cfg)) {
      throw new Error("Scheduled plugin command configuration changed before admission.");
    }
    const revision = resolveCronRequesterExecutionRevision(job);
    let active = true;
    const assertSource = () => {
      if (!active) {
        throw new Error("Scheduled plugin command occurrence closed.");
      }
      request.abortSignal?.throwIfAborted();
      assertOccurrence();
      fence.assertCurrent();
      const current: CronStoredJob | undefined = context.cron.getJob(job.id);
      if (
        params.resolveGatewayContext?.() !== context ||
        context.resolveGatewayContext?.() !== context ||
        params.resolvePluginRegistry?.() !== registry ||
        getConfig() !== configAtAdmission ||
        !current ||
        resolveCronRequesterExecutionRevision(current) !== revision ||
        !isDeepStrictEqual(current.pluginCommand, schedule) ||
        !isDeepStrictEqual(current.state.pluginCommandBinding, job.state.pluginCommandBinding) ||
        Date.now() >= schedule.deadlineAtMs
      ) {
        throw new Error("Scheduled plugin command source changed or expired.");
      }
      assertPluginCommandScheduleRegistry(registry, schedule, binding);
    };
    assertSource();
    // The ordinary dispatcher exposes ambient completion and converts failures to chat text.
    // A host-only strict entry point must be present BEFORE accepting input.
    const execute = params.executeScheduledDispatch;
    if (!execute) {
      throw new Error(
        "Scheduled plugin command dispatch requires the host's fenced completion and error contract.",
      );
    }
    const storePath = resolveSessionStorePathForScope(schedule.parent, cfg);
    const currentSession = await captureSessionEntryCurrentCheckAsyncInternal({
      agentId: schedule.parent.agentId,
      sessionKey: schedule.parent.sessionKey,
      storePath,
      config: cfg,
      fields: [
        "archivedAt",
        "permissionMode",
        "toolOverrides",
        "authProfileOverride",
        "authProfileOverrideSource",
        "providerOverride",
        "modelOverride",
        "inheritedToolPolicyVersion",
        "inheritedToolAllow",
        "inheritedToolDeny",
        "delegatedToolPolicy",
      ],
      isActive: () => active && !request.abortSignal?.aborted,
    });
    let restored: Awaited<ReturnType<typeof restoreGatewayQueuedOperatorRecovery>> | undefined;
    let inference: Awaited<ReturnType<typeof acquireCronInferenceAuthorization>> | undefined;
    let modelLease: ReturnType<typeof bindOperatorModelExecution>;
    let admission: ReturnType<typeof prepareCronRunAdmission> | undefined;
    try {
      assertSource();
      const entry = currentSession.entry;
      if (
        !entry ||
        entry.archivedAt ||
        entry.sessionId !== schedule.parent.sessionId ||
        entry.lifecycleRevision !== schedule.parent.lifecycleRevision
      ) {
        throw new Error("Scheduled plugin command parent was deleted, reset or archived.");
      }
      const assertParent = composeSessionSourceAssertion(
        [currentSession.source],
        (assertSession) => {
          assertSource();
          assertSession();
        },
      );
      assertParent();
      // Restoration owns the original operator source, not the invocation lifetime.
      // Every scheduled effect separately composes assertParent below; accepted children
      // retain the native operator lease without inheriting a closed occurrence callback.
      restored = await restoreGatewayQueuedOperatorRecovery({
        source: schedule.operatorSource,
        context,
        assertCurrent: () => {
          if (
            params.resolveGatewayContext?.() !== context ||
            context.resolveGatewayContext?.() !== context
          ) {
            throw new Error("Scheduled command Gateway operator source changed.");
          }
        },
      });
      assertParent();
      const operatorAuthority = restored.authority;
      const assertCurrent = composeSessionSourceAssertion(
        [assertParent, operatorAuthority.assertCurrent],
        (assertSources) => {
          assertSources();
          inference?.assertCurrent();
          modelLease?.assertCurrent();
        },
      );
      assertCurrent();
      const model = resolveSessionModelRef(cfg, entry, schedule.parent.agentId);
      modelLease = bindOperatorModelExecution(operatorAuthority, model);
      assertCurrent();
      if (job.inferenceBinding) {
        if (job.inferenceBinding.provider !== model.provider) {
          throw new Error("Scheduled plugin command provider route changed.");
        }
        inference = await acquireCronInferenceAuthorization({
          binding: job.inferenceBinding,
          cfg,
          agentDir: resolveAgentDir(cfg, schedule.parent.agentId),
        });
        assertCurrent();
        await inference.revalidate();
        assertCurrent();
        const route = await captureCronInferenceBinding({
          cfg,
          agentId: schedule.parent.agentId,
          sessionEntry: entry,
          model: model.provider + "/" + model.model + "@" + job.inferenceBinding.profileId,
        });
        assertCurrent();
        if (
          !route ||
          route.provider !== job.inferenceBinding.provider ||
          route.profileId !== job.inferenceBinding.profileId ||
          route.authorizationId !== job.inferenceBinding.authorizationId ||
          route.authRequirement !== job.inferenceBinding.authRequirement
        ) {
          throw new Error("Scheduled plugin command inference route or account changed.");
        }
      }
      const signals = [request.abortSignal, operatorAuthority.signal, modelLease?.signal].filter(
        (signal): signal is AbortSignal => Boolean(signal),
      );
      const upstream = signals.length ? AbortSignal.any(signals) : undefined;
      return await withSessionTurn(
        { ...schedule.parent, storePath, abortSignal: upstream },
        async (_operation, signal): Promise<ScheduledResult> => {
          turnSignal = signal;
          const assertTurn = composeSessionSourceAssertion([assertCurrent], (assertSources) => {
            signal.throwIfAborted();
            assertSources();
          });
          assertTurn();
          const runId = randomUUID();
          const commandBody = "/" + schedule.command + (schedule.args ? " " + schedule.args : "");
          const runtime = commandRuntime.createPluginCommandRuntime();
          const match = commandRuntime.matchPluginCommandInvocation(runtime, commandBody, {
            channel: schedule.channel,
          });
          if (!match || !match.requireAuth) {
            throw new Error("Scheduled plugin command has no authenticated native dispatch.");
          }
          const recorder = createUserTurnTranscriptRecorder({
            input: {
              text: commandBody,
              idempotencyKey: buildRunUserTurnIdempotencyKey(runId),
              provenance: {
                kind: "internal_system",
                sourceTool: "plugin-command-schedule",
                jobId: job.id,
                runId,
                sourceSessionKey: schedule.parent.sessionKey,
                originSessionId: schedule.parent.sessionId,
                sourceChannel: schedule.channel,
              },
            },
            target: {
              ...schedule.parent,
              sessionEntry: entry,
              expectedSessionId: entry.sessionId,
              storePath,
              config: cfg,
            },
            assertOriginalInputCommit: assertTurn,
          });
          const commitTurn = async (assertInvocation: () => void) => {
            assertInvocation();
            assertTurn();
            await recorder.persistApproved({
              expectedSessionId: entry.sessionId,
              beforeFreshMessageCommit: assertTurn,
            });
            assertTurn();
            assertInvocation();
            const receipt = recorder.getAdmissionReceipt();
            return (
              receipt?.agentId === schedule.parent.agentId &&
              receipt.sessionKey === schedule.parent.sessionKey &&
              receipt.sessionId === entry.sessionId
            );
          };
          // No stageApproved/lifecycle recovery patch: native cron receipt alone owns interruption.
          await fence.beforeAttempt();
          assertTurn();
          if (!(await commitTurn(assertTurn))) {
            throw new Error("Scheduled command input was not committed to its bound parent.");
          }
          assertTurn();
          admission = prepareCronRunAdmission({
            // The operator source was restored above, so its requester is current.
            scheduledExecution: request.occurrence.mint({
              cfg,
              agentId: schedule.parent.agentId,
              runId,
              runSessionKey: schedule.parent.sessionKey,
              toolsAllow,
              operatorAuthority,
            }),
            admissionSource: request.admissionSource,
            cfg,
            agentId: schedule.parent.agentId,
            runId,
            sessionId: entry.sessionId,
            sessionKey: schedule.parent.sessionKey,
            jobId: job.id,
            deliveryAttemptFence: fence,
            executionIdentity: request.executionIdentity,
            operatorAuthority,
            toolsAllow: [...toolsAllow],
            scheduledToolPolicy: job.scheduledToolPolicy,
            resolveGatewayContext: params.resolveGatewayContext,
          });
          const prepared = admission.preparedRunAdmission;
          const admitted = await prepared.admit("plugin-harness", schedule.pluginId);
          assertTurn();
          const identity = createAdmittedGatewayToolCallerIdentity({
            admittedRunContext: admitted,
            agentId: schedule.parent.agentId,
            sessionKey: schedule.parent.sessionKey,
            receiptAuthority: assertTurn,
            approvalSignals: [signal],
            turnSourceChannel: schedule.channel,
          });
          if (!identity) {
            throw new Error("Scheduled command admission did not bind its original operator.");
          }
          executionStarted = true;
          request.onExecutionStarted?.({
            jobId: job.id,
            agentId: schedule.parent.agentId,
            runId,
            sessionId: entry.sessionId,
            sessionKey: schedule.parent.sessionKey,
          });
          assertTurn();
          const result = await withGatewayToolCallerIdentity(identity, () =>
            withRequesterNativeSubagents(
              {
                cfg,
                sessionAgentId: schedule.parent.agentId,
                sessionKey: schedule.parent.sessionKey,
                entry,
                runId,
                operatorAuthority,
                commandIngressEligible: true,
                authorizeRequester: async () => {
                  assertTurn();
                  return {
                    isAuthorizedSender: true,
                    senderIsOwner: false,
                    assertOwnerCurrent: assertTurn,
                  };
                },
                resolveToolAuthority: () => ({
                  toolsAllow: [...toolsAllow],
                  permissionMode: entry.permissionMode,
                  toolOverrides: entry.toolOverrides,
                  senderIsOwner: false,
                  disableTools: false,
                  traceAuthorized: false,
                  operatorAuthority,
                }),
                messageChannel: schedule.channel,
                getAbortSignal: () => signal,
                assertCurrent: assertTurn,
                commitTurn,
                prepareAdmission: ({
                  assertSourceCurrent,
                  onAdmitted,
                }): PreparedAgentRunAdmission => ({
                  ...prepared,
                  assertSourceCurrent: () => {
                    assertTurn();
                    assertSourceCurrent();
                    prepared.assertSourceCurrent();
                  },
                  admit: async (kind, instanceId) => {
                    assertTurn();
                    assertSourceCurrent();
                    const current = await prepared.admit(kind, instanceId);
                    assertTurn();
                    assertSourceCurrent();
                    onAdmitted(current);
                    assertTurn();
                    assertSourceCurrent();
                    return current;
                  },
                }),
              },
              (createSubagents) =>
                racePromiseWithAbortSignal(
                  execute(match.dispatch, {
                    channel: schedule.channel,
                    isAuthorizedSender: true,
                    senderIsOwner: false,
                    assertOwnerCurrent: assertTurn,
                    gatewayClientScopes: [...operatorAuthority.scopes],
                    ...schedule.parent,
                    authProfileId: job.inferenceBinding?.profileId,
                    commandBody,
                    config: cfg,
                    runtimeContext: { createSubagents },
                    abortSignal: signal,
                    inferenceBinding: job.inferenceBinding,
                  }),
                  signal,
                ),
            ),
          );
          assertTurn();
          if (result.continueAgent) {
            throw new Error("Scheduled plugin commands cannot continue into the agent/LLM path.");
          }
          const mediaUrls = result.mediaUrls ?? (result.mediaUrl ? [result.mediaUrl] : undefined);
          const text = result.text ?? result.fallbackText?.text;
          if (text || mediaUrls?.length) {
            const appended = await appendAssistantMessageToSessionTranscript({
              ...schedule.parent,
              storePath,
              config: cfg,
              expectedSessionId: entry.sessionId,
              expectedLifecycleRevision: entry.lifecycleRevision ?? null,
              runId,
              idempotencyKey: "plugin-command-schedule:" + runId,
              text,
              mediaUrls,
              assertCurrent: assertTurn,
            });
            assertTurn();
            if (!appended.ok) {
              throw new Error(
                "Scheduled command result was not committed to its parent: " + appended.reason,
              );
            }
          } else if (
            result.presentation ||
            result.interactive ||
            result.attachments?.length ||
            result.location ||
            result.channelData
          ) {
            throw new Error(
              "Scheduled command result requires an unsupported external delivery route.",
            );
          }
          return {
            status: result.isError ? "error" : "ok",
            ...(result.isError ? { error: text ?? "Plugin command failed." } : {}),
            executionStarted: true,
            sessionId: entry.sessionId,
            sessionKey: schedule.parent.sessionKey,
            outputText: text,
            summary: text,
            delivered: false,
            deliveryAttempted: false,
          };
        },
      );
    } finally {
      active = false;
      try {
        await admission?.finish();
      } finally {
        modelLease?.release();
        inference?.dispose();
        restored?.release();
        currentSession.release();
      }
    }
  } catch (error) {
    return {
      status: "error",
      error: formatErrorMessage(error),
      ...(turnSignal?.aborted || params.request.abortSignal?.aborted || isAbortError(error)
        ? { errorClassification: { kind: "aborted" as const } }
        : error instanceof PluginCommandScheduleInstanceReplacedError
          ? // Settlement retires the schedule on this first refusal.
            { errorClassification: { kind: "permanent" as const } }
          : {}),
      executionStarted,
      delivered: false,
      deliveryAttempted: false,
    };
  }
}
