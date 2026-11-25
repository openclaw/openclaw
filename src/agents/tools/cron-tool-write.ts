// Agent cron-tool write safety and optimistic update orchestration.
import { isDeepStrictEqual } from "node:util";
import { normalizeLowercaseStringOrEmpty } from "@openclaw/normalization-core/string-coerce";
import { createRuntimeConfigReader } from "../../config/runtime-snapshot.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import {
  CRON_STREAM_EXEC_AUTHORITY_ERROR,
  CronStreamExecApprovalRequiredError,
  cronMutationRequiresStreamExecAuthority,
  cronUpdateRequiresStreamExecAuthority,
  type CronStreamExecPolicy,
} from "../../cron/stream-exec-authority.js";
import { createExecApprovalPolicySnapshot } from "../../infra/exec-approvals-allow-always.js";
import { requiresExecApproval } from "../../infra/exec-approvals-policy.js";
import { loadExecApprovalsReadOnlyAsync } from "../../infra/exec-approvals-store.js";
import { applyExecPolicyLayer } from "../../infra/exec-policy.js";
import { isRecord } from "../../utils.js";
import { resolveAgentConfig, resolveAgentWorkspaceDir } from "../agent-scope-config.js";
import { resolveEffectiveToolPolicy } from "../agent-tools.policy.js";
import {
  prepareExecDefaults,
  resolveExecConfigState,
  resolvePreparedExecDefaultsAsync,
  type ResolvedExecDefaults,
} from "../exec-defaults.js";
import { captureSandboxConfig, resolveSandboxConfigForAgent } from "../sandbox/config.js";
import { withSandboxRuntimeStatusInWorker } from "../sandbox/runtime-status.js";
import { readStreamSandboxContext } from "../sandbox/stream-context.js";
import type { SandboxContext } from "../sandbox/types.js";
import { projectEffectiveExecPolicy } from "../session-permission-exec-mode.js";
import {
  assertInheritedCronToolCaptureReady,
  CRON_CREATOR_AUTHORITY_RECOVERY_MESSAGE,
  hasCronCreatorGatewayExecTool,
  hasCronCreatorSandboxExecTool,
  INCOMPLETE_CRON_CREATOR_AUTHORITY_MESSAGE,
  isCronCreatorToolCaptureComplete,
  planCronJobUpdatePatch,
  resolveCronCreatorExecToolTarget,
} from "./cron-tool-creator-cap.js";
import type {
  CronCreatorToolAllowlistEntry,
  CronCreatorToolAuthoritySnapshot,
  CronToolOptions,
  CronToolsAllowCaptureRef,
  GatewayToolCaller,
} from "./cron-tool.types.js";
import type { GatewayCallOptions } from "./gateway.js";

/** Retain the config owner when tools are assembled, before a later config publication. */
export function captureCronStreamPolicyConfigCurrentness(opts: CronToolOptions | undefined) {
  const readConfig = opts?.config ? createRuntimeConfigReader(opts.config) : () => undefined;
  const project = (cfg: OpenClawConfig | undefined) => {
    const { agentId, globalExec, agentExec } = resolveExecConfigState({
      cfg,
      agentId: opts?.agentId,
      sessionKey: opts?.agentSessionKey,
    });
    return {
      globalExec,
      agentExec,
      tools: resolveEffectiveToolPolicy({
        config: cfg,
        agentId,
        sessionKey: opts?.agentSessionKey,
      }),
      globalProviderTools: cfg?.tools?.byProvider,
      subagentTools: cfg?.tools?.subagents?.tools,
      agentProviderTools:
        cfg && agentId ? resolveAgentConfig(cfg, agentId)?.tools?.byProvider : undefined,
      sandbox: resolveSandboxConfigForAgent(cfg, agentId),
      workspaceDir: cfg && agentId ? resolveAgentWorkspaceDir(cfg, agentId) : undefined,
    };
  };
  const { sandbox, ...policy } = project(opts?.config);
  const captured = { ...structuredClone(policy), sandbox: captureSandboxConfig(sandbox) };
  return () => {
    if (!isDeepStrictEqual(project(readConfig()), captured)) {
      throw new TypeError(
        "Creator execution policy changed before saving the stream; retry from the current turn.",
      );
    }
  };
}

function assertCronStreamExecAuthority(params: {
  value: unknown;
  required?: boolean;
  creatorToolAllowlist: readonly CronCreatorToolAllowlistEntry[] | undefined;
  execDefaults: ResolvedExecDefaults | undefined;
  sandboxContext?: SandboxContext;
  sandboxExplicitlyDenied?: boolean;
  policyKey?: string;
  approvedPolicyKey?: string;
}): void {
  if (!(params.required ?? cronMutationRequiresStreamExecAuthority(params.value))) {
    return;
  }
  const pinnedTarget = resolveCronCreatorExecToolTarget(params.creatorToolAllowlist);
  const effectiveAsk = pinnedTarget?.ask ?? params.execDefaults?.ask;
  const inSandbox = params.execDefaults?.effectiveHost === "sandbox";
  if (
    !params.execDefaults ||
    (inSandbox
      ? !params.sandboxContext ||
        !hasCronCreatorSandboxExecTool(params.creatorToolAllowlist) ||
        params.sandboxExplicitlyDenied
      : !hasCronCreatorGatewayExecTool(params.creatorToolAllowlist) ||
        params.execDefaults.effectiveHost !== "gateway" ||
        params.execDefaults.security === "deny" ||
        (params.execDefaults.security === "allowlist" && effectiveAsk === "off"))
  ) {
    throw new TypeError(CRON_STREAM_EXEC_AUTHORITY_ERROR);
  }
  if (inSandbox && params.sandboxContext) {
    readStreamSandboxContext(params.sandboxContext);
  }
  if (
    params.policyKey !== undefined &&
    (inSandbox
      ? effectiveAsk !== "off"
      : requiresExecApproval({
          security: params.execDefaults.security,
          ask: effectiveAsk ?? params.execDefaults.ask,
          // A persistent watcher is not an analyzed one-shot allowlist command.
          analysisOk: false,
          allowlistSatisfied: false,
        })) &&
    params.approvedPolicyKey !== params.policyKey
  ) {
    throw new CronStreamExecApprovalRequiredError(
      params.policyKey,
      params.execDefaults.security,
      effectiveAsk ?? params.execDefaults.ask,
    );
  }
}

/** Prepares the caller's policy for revalidation by the cron write owner. */
export async function prepareCronStreamExecPolicy(input: {
  opts: CronToolOptions | undefined;
  creatorTools: readonly CronCreatorToolAllowlistEntry[] | undefined;
  operationSignal?: AbortSignal;
  assertConfigCurrent: () => void;
}): Promise<CronStreamExecPolicy> {
  const { opts, creatorTools, operationSignal } = input;
  const assertCurrentSource = () => {
    operationSignal?.throwIfAborted();
    input.assertConfigCurrent();
  };
  assertCurrentSource();
  const params = {
    cfg: opts?.config,
    sessionEntry: opts?.execSession,
    execOverrides: opts?.execOverrides,
    agentId: opts?.agentId,
    sessionKey: opts?.agentSessionKey,
    sandboxAvailable: opts?.sandboxed,
  };
  const { agentId, globalExec, agentExec } = resolveExecConfigState(params);
  const configuredPolicy = projectEffectiveExecPolicy({
    base: applyExecPolicyLayer(globalExec ?? {}, agentExec),
    overrides: params.execOverrides,
    permissionPolicy: params.sessionEntry?.permissionMode
      ? { mode: params.sessionEntry.permissionMode }
      : undefined,
  });
  const sandboxExplicitlyDenied =
    configuredPolicy.security === "deny" || configuredPolicy.mode === "deny";
  return await withSandboxRuntimeStatusInWorker(
    { cfg: params.cfg, agentId, sessionKey: params.sessionKey },
    {
      env: process.env,
      cwd: process.cwd(),
      assertCurrent: assertCurrentSource,
    },
    async (sandbox): Promise<CronStreamExecPolicy> => {
      const preparation = prepareExecDefaults(params, sandbox);
      const creatorToolAllowlist = creatorTools ? structuredClone(creatorTools) : undefined;
      const defaults = await resolvePreparedExecDefaultsAsync(
        preparation,
        loadExecApprovalsReadOnlyAsync,
      );
      assertCurrentSource();
      const sandboxContext =
        defaults.effectiveHost === "sandbox" ? opts?.sandboxContext : undefined;
      assertCronStreamExecAuthority({
        value: undefined,
        required: true,
        creatorToolAllowlist,
        execDefaults: defaults,
        sandboxContext,
        sandboxExplicitlyDenied,
      });
      // Keep policy inputs private; the write owner supplies the approval row
      // from the same transaction that commits the stream mutation.
      const assertDefaults = (
        execDefaults: typeof defaults,
        policyKey: string,
        approvedPolicyKey?: string,
      ) => {
        assertCurrentSource();
        assertCronStreamExecAuthority({
          value: undefined,
          required: true,
          creatorToolAllowlist,
          execDefaults,
          sandboxContext,
          sandboxExplicitlyDenied,
          policyKey,
          approvedPolicyKey,
        });
      };
      return preparation.kind === "resolved"
        ? {
            kind: "resolved",
            sandboxContext,
            assertCurrentSource,
            assertCurrent: (approvedPolicyKey) =>
              assertDefaults(
                preparation.defaults,
                JSON.stringify(preparation.defaults),
                approvedPolicyKey,
              ),
          }
        : {
            kind: "needs-approvals",
            assertCurrentSource,
            assertCurrent: (file, approvedPolicyKey) =>
              assertDefaults(
                preparation.resolve(file),
                JSON.stringify([
                  preparation.resolve(file),
                  createExecApprovalPolicySnapshot({ file, agentId }),
                ]),
                approvedPolicyKey,
              ),
          };
    },
  );
}

/** Context-free operator calls cannot silently bypass an agent tool's required question. */
export async function assertCronStreamExecPolicyWithoutApproval(
  policy: CronStreamExecPolicy,
): Promise<void> {
  if (policy.sandboxContext) {
    throw new TypeError(
      "Sandbox streams require a current creator grant to carry their sandbox target.",
    );
  }
  if (policy.kind === "resolved") {
    policy.assertCurrent();
  } else {
    policy.assertCurrent(await loadExecApprovalsReadOnlyAsync());
  }
}

export function assertNoCronShellExecution(value: unknown): void {
  if (!isRecord(value)) {
    return;
  }
  const payload = isRecord(value.payload) ? value.payload : undefined;
  if (normalizeLowercaseStringOrEmpty(payload?.kind) === "command") {
    throw new Error(
      "automation command payloads cannot be created or edited through the agent automations tool; use the CLI or Gateway API.",
    );
  }
  const schedule = isRecord(value.schedule) ? value.schedule : undefined;
  if (schedule?.kind === "on-exit") {
    throw new Error(
      "automation on-exit schedules cannot be created or edited through the agent automations tool; use the CLI or Gateway API.",
    );
  }
  // Stream argv has a separate Gateway exec and persistent approval check below;
  // keep it out of this blanket operator-only payload/schedule prohibition.
}

export function assertCronCreatorAuthorityResolutionAvailable(params: {
  required: boolean;
  resolveCreatorToolAuthority?: unknown;
  creatorToolAllowlistCaptureRef?: CronToolsAllowCaptureRef;
  unavailableReason?: "queued-local-operator-configured-mcp";
}): void {
  if (!params.required || params.resolveCreatorToolAuthority) {
    return;
  }
  if (
    params.unavailableReason === "queued-local-operator-configured-mcp" ||
    !isCronCreatorToolCaptureComplete(params.creatorToolAllowlistCaptureRef)
  ) {
    throw new Error(
      params.unavailableReason === "queued-local-operator-configured-mcp"
        ? `Configured MCP authority is unavailable because this local operator turn was queued. ${CRON_CREATOR_AUTHORITY_RECOVERY_MESSAGE}`
        : INCOMPLETE_CRON_CREATOR_AUTHORITY_MESSAGE,
    );
  }
}

function readCronScheduleWithoutTimezone(
  patch: Record<string, unknown>,
): Record<string, unknown> | undefined {
  const schedule = patch.schedule;
  return isRecord(schedule) && schedule.kind === "cron" && schedule.tz === undefined
    ? schedule
    : undefined;
}

function inheritCronScheduleTimezone(
  patch: Record<string, unknown>,
  currentJob: Record<string, unknown> | undefined,
): Record<string, unknown> {
  const schedule = readCronScheduleWithoutTimezone(patch);
  const currentSchedule = currentJob?.schedule;
  if (
    !schedule ||
    !isRecord(currentSchedule) ||
    currentSchedule.kind !== "cron" ||
    typeof currentSchedule.tz !== "string"
  ) {
    return patch;
  }
  return { ...patch, schedule: { ...schedule, tz: currentSchedule.tz } };
}

async function prepareCronJobUpdateForGateway(
  params: Parameters<typeof updateCronJobFromAgentTool>[0] & {
    creatorAuthorityComplete: boolean;
  },
): Promise<{
  patch: Record<string, unknown>;
  expectedConfigRevision?: string;
  resolvedAuthority?: CronCreatorToolAuthoritySnapshot;
  streamExecAuthorityRequired: boolean;
}> {
  params.operationSignal?.throwIfAborted();
  const initialPlan = planCronJobUpdatePatch({
    patch: params.patch,
    creatorToolAllowlist: params.creatorToolAllowlist,
    creatorAuthorityComplete: params.creatorAuthorityComplete,
  });
  if (initialPlan.kind === "ready" && !readCronScheduleWithoutTimezone(initialPlan.patch)) {
    return {
      patch: initialPlan.patch,
      expectedConfigRevision: params.expectedConfigRevision,
      streamExecAuthorityRequired: false,
    };
  }

  const existing = await params.callGateway("cron.get", params.gatewayOpts, { id: params.id });
  params.operationSignal?.throwIfAborted();
  const existingRecord = isRecord(existing) ? existing : undefined;
  const expectedConfigRevision = existingRecord?.configRevision;
  if (
    !existingRecord ||
    typeof expectedConfigRevision !== "string" ||
    expectedConfigRevision.length === 0
  ) {
    throw new Error(
      "cron.get response is missing configRevision; restart the Gateway before retrying this update",
    );
  }
  if (
    params.expectedConfigRevision !== undefined &&
    params.expectedConfigRevision !== expectedConfigRevision
  ) {
    throw new Error(
      "The selected automation changed while waiting. Select its current definition again.",
    );
  }
  let resolvedAuthority: CronCreatorToolAuthoritySnapshot | undefined;
  let finalPlan = planCronJobUpdatePatch({
    patch: params.patch,
    creatorToolAllowlist: params.creatorToolAllowlist,
    currentJob: existingRecord,
    creatorAuthorityComplete: params.creatorAuthorityComplete,
  });
  if (finalPlan.kind === "needs-creator-authority") {
    assertCronCreatorAuthorityResolutionAvailable({
      required: true,
      resolveCreatorToolAuthority: params.resolveCreatorToolAuthority,
      creatorToolAllowlistCaptureRef: params.creatorToolAllowlistCaptureRef,
      unavailableReason: params.creatorAuthorityUnavailableReason,
    });
    if (!params.resolveCreatorToolAuthority) {
      throw new Error("cron update requires complete creator tool authority");
    }
    resolvedAuthority = await params.resolveCreatorToolAuthority({
      signal: params.operationSignal,
    });
    params.operationSignal?.throwIfAborted();
    finalPlan = planCronJobUpdatePatch({
      patch: params.patch,
      creatorToolAllowlist: resolvedAuthority.tools,
      currentJob: existingRecord,
      creatorAuthorityComplete: true,
      creatorHoldsRuntimeAuthority: resolvedAuthority.holdsRuntimeAuthority,
    });
  }
  if (finalPlan.kind !== "ready") {
    throw new Error("cron update patch planning did not use the loaded job");
  }
  return {
    patch: inheritCronScheduleTimezone(finalPlan.patch, existingRecord),
    expectedConfigRevision,
    resolvedAuthority,
    streamExecAuthorityRequired: cronUpdateRequiresStreamExecAuthority(
      finalPlan.patch,
      existingRecord,
    ),
  };
}

function isCronJobConfigRevisionConflict(error: unknown): boolean {
  if (!(error instanceof Error) || error.name !== "GatewayClientRequestError") {
    return false;
  }
  const details = isRecord((error as Error & { details?: unknown }).details)
    ? (error as Error & { details: Record<string, unknown> }).details
    : undefined;
  return details?.code === "CRON_JOB_CHANGED";
}

export async function updateCronJobFromAgentTool(params: {
  id: string;
  expectedConfigRevision?: string;
  patch: Record<string, unknown>;
  adminManagement?: boolean;
  creatorToolAllowlist: readonly CronCreatorToolAllowlistEntry[] | undefined;
  creatorToolAllowlistCaptureRef?: CronToolsAllowCaptureRef;
  resolveCreatorToolAuthority?: (options?: {
    signal?: AbortSignal;
  }) => Promise<CronCreatorToolAuthoritySnapshot>;
  withCreatorAuthorityProvenance?: <T>(
    authority: CronCreatorToolAuthoritySnapshot,
    run: () => Promise<T>,
  ) => Promise<T>;
  gatewayOpts: GatewayCallOptions;
  callGateway: GatewayToolCaller;
  operationSignal?: AbortSignal;
  creatorAuthorityUnavailableReason?: "queued-local-operator-configured-mcp";
  prepareStreamExecAuthority: (
    creatorToolAllowlist: readonly CronCreatorToolAllowlistEntry[] | undefined,
  ) => Promise<void>;
}): Promise<unknown> {
  const callerIncludedPayloadPatch = isRecord(params.patch.payload);
  let creatorAuthorityPromise: Promise<CronCreatorToolAuthoritySnapshot> | undefined;
  const resolveCreatorToolAuthority = params.resolveCreatorToolAuthority
    ? (options?: { signal?: AbortSignal }) =>
        (creatorAuthorityPromise ??= params.resolveCreatorToolAuthority!(options))
    : undefined;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    params.operationSignal?.throwIfAborted();
    const prepared = await prepareCronJobUpdateForGateway({
      ...params,
      creatorAuthorityComplete:
        isCronCreatorToolCaptureComplete(params.creatorToolAllowlistCaptureRef) &&
        resolveCreatorToolAuthority === undefined &&
        params.creatorAuthorityUnavailableReason === undefined,
      resolveCreatorToolAuthority,
    });
    if (!params.adminManagement && callerIncludedPayloadPatch) {
      // Kind-less caller payloads inherit the stored kind above. Recheck those
      // edits, but not a toolsAllow cap synthesized internally.
      assertNoCronShellExecution(prepared.patch);
    }
    if (prepared.streamExecAuthorityRequired) {
      await params.prepareStreamExecAuthority(
        prepared.resolvedAuthority?.tools ?? params.creatorToolAllowlist,
      );
    }
    assertInheritedCronToolCaptureReady(
      prepared.patch,
      prepared.resolvedAuthority
        ? { value: prepared.resolvedAuthority.provenance }
        : params.creatorToolAllowlistCaptureRef,
    );
    if (prepared.resolvedAuthority && !params.withCreatorAuthorityProvenance) {
      throw new Error(
        "fresh configured MCP cron authority requires an authenticated local agent run",
      );
    }
    try {
      const write = async () => {
        params.operationSignal?.throwIfAborted();
        return await params.callGateway("cron.update", params.gatewayOpts, {
          id: params.id,
          patch: prepared.patch,
          ...(prepared.expectedConfigRevision
            ? { expectedConfigRevision: prepared.expectedConfigRevision }
            : {}),
        });
      };
      return prepared.resolvedAuthority && params.withCreatorAuthorityProvenance
        ? await params.withCreatorAuthorityProvenance(prepared.resolvedAuthority, write)
        : await write();
    } catch (error) {
      if (
        attempt === 0 &&
        params.expectedConfigRevision === undefined &&
        isCronJobConfigRevisionConflict(error)
      ) {
        continue;
      }
      throw error;
    }
  }
  throw new Error("cron update retry exhausted");
}
