import {
  ErrorCodes,
  errorShape,
  validateUpdateRunParams,
} from "../../../packages/gateway-protocol/src/index.js";
import type { PreparedCommandOwnerAuthority } from "../../auto-reply/command-auth.js";
import { UpdatePreMutationError } from "../../cli/update-cli/shared.js";
import { isRestartEnabled } from "../../config/commands.flags.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { formatInstallOwnerMessage, readInstallOwner } from "../../infra/install-owner.js";
import { resolveOcmUpdateManager } from "../../infra/ocm-update-client.js";
import { resolveOpenClawPackageRoot } from "../../infra/openclaw-root.js";
import { tryProcessCwd } from "../../infra/safe-cwd.js";
import { normalizeUpdateChannel } from "../../infra/update-channels.js";
import { currentUpdateCheckLifecycle } from "../../infra/update-check-lifecycle.js";
import { createUpdateErrorFact } from "../../infra/update-failure-facts.js";
import {
  createFreeBsdPkgOwnershipInspection,
  FreeBsdPkgOwnershipError,
} from "../../infra/update-freebsd-pkg-ownership.js";
import { inspectImmutableInstall } from "../../infra/update-immutable-install.js";
import { resolveStartupInstallStatus } from "../../infra/update-install-status.js";
import {
  createUpdatePreflightFailure,
  UPDATE_HANDOFF_BEFORE_TRANSFER_DETAIL,
  type UPDATE_PREFLIGHT_DETAILS,
} from "../../infra/update-preflight-details.js";
import type { UpdateRequester } from "../../infra/update-requester-authority.js";
import { summarizeUpdateStepFailure, type UpdateRunRecord } from "../../infra/update-run-record.js";
import {
  recordUpdateRunDiagnosticsAsync as recordUpdateRunDiagnostics,
  recordUpdateRunPhaseAsync as recordUpdateRunPhase,
  recordUpdateRunStepAsync as recordUpdateRunStep,
  finishUpdateRunAsync as finishUpdateRun,
} from "../../infra/update-run-write.async.js";
import { resolveUpdateInstallSurface } from "../../infra/update-runner-install-surface.js";
import type { UpdateInstallSurface, UpdateRunResult } from "../../infra/update-runner-types.js";
import { isInternalMessageChannel } from "../../utils/message-channel.js";
import { readGatewayRequestMutationAuthority } from "./session-mutation-guards.js";
import type { GatewayRequestHandlerOptions } from "./types.js";
import { assertValidParams } from "./validation.js";

/** Native params are returned only when this request still belongs to the native updater. */
export async function admitGatewayUpdateRequest(request: GatewayRequestHandlerOptions) {
  const { params, respond, context } = request;
  if (!assertValidParams(params, validateUpdateRunParams, "update.run", respond)) {
    return null;
  }
  const authority = readGatewayRequestMutationAuthority(request);
  const root = await resolveOpenClawPackageRoot({
    moduleUrl: import.meta.url,
    argv1: process.argv[1],
    cwd: tryProcessCwd(),
  });
  const installOwner = await readInstallOwner(root);
  if (installOwner) {
    respond(
      false,
      undefined,
      errorShape(ErrorCodes.UNAVAILABLE, formatInstallOwnerMessage(installOwner), {
        details: { reason: "host-owned-install", installOwner },
        retryable: false,
      }),
    );
    return null;
  }
  if (root && (await inspectImmutableInstall(root))) {
    respond(
      false,
      undefined,
      errorShape(ErrorCodes.UNAVAILABLE, IMMUTABLE_UPDATE_GUIDANCE, {
        details: { reason: "immutable-native-updater-required" },
        retryable: false,
      }),
    );
    return null;
  }
  const channel = params.requester?.channel;
  const manager =
    !channel || isInternalMessageChannel(channel) ? await resolveOcmUpdateManager() : null;
  if (!manager?.canStart) {
    return params;
  }
  if (params.target) {
    respond(
      false,
      undefined,
      errorShape(
        ErrorCodes.INVALID_REQUEST,
        "This OCM version does not support an explicit Git update target.",
      ),
    );
    return null;
  }
  const run = await manager.start(
    authority.assertCurrent,
    normalizeUpdateChannel(context.getRuntimeConfig().update?.channel),
  );
  respond(true, {
    runId: run.runId,
    ok: run.status === "running" || run.status === "succeeded" || run.status === "skipped",
    result: {
      status:
        run.status === "running" || run.status === "skipped"
          ? "skipped"
          : run.status === "succeeded"
            ? "ok"
            : "error",
      reason: run.reason,
    },
    ...(run.status === "running" ? { handoff: { status: "started" } } : {}),
    message: "OCM owns this update. Use the Update status view to follow its progress and result.",
  });
  return null;
}

const IMMUTABLE_UPDATE_GUIDANCE =
  "Run openclaw update as the root installation owner outside the Gateway service cgroup. Native immutable activation requires an explicitly enabled adoption record; use openclaw update recover --root <installation-root> for retained recovery. Gateway update.run cannot acquire that external updater authority.";

export async function reportImmutableGatewayUpdateRefusal(
  runId: string,
  installSurface: Extract<UpdateInstallSurface, { kind: "immutable" }>,
  respond: GatewayRequestHandlerOptions["respond"],
): Promise<void> {
  const reason = "immutable-native-updater-required";
  await recordUpdateRunPhase(runId, "requested", {
    origin: { nextAction: IMMUTABLE_UPDATE_GUIDANCE },
  });
  await finishUpdateRun(runId, { status: "skipped", reason });
  respond(true, {
    runId,
    ok: false,
    message: IMMUTABLE_UPDATE_GUIDANCE,
    result: {
      status: "skipped",
      mode: installSurface.mode,
      root: installSurface.root,
      reason,
      steps: [],
      durationMs: 0,
    },
    restart: null,
  });
}

export function retainUpdateRequesterAuthority(
  requester: UpdateRequester | undefined,
  authority: PreparedCommandOwnerAuthority | undefined,
  getConfig: () => OpenClawConfig,
) {
  return {
    signal: authority?.signal,
    assertCurrent: () => {
      if (!requester?.channel || isInternalMessageChannel(requester.channel)) {
        return;
      }
      const config = getConfig();
      if (
        !requester.authorizationSource ||
        !authority?.isCurrent(config) ||
        !isRestartEnabled(config)
      ) {
        throw new Error("Update requester authority changed before parking.");
      }
    },
  };
}

export async function resolveGatewayUpdateAdmission(runId: string, timeoutMs?: number) {
  await recordUpdateRunStep(runId, { step: "installation-inspection", status: "in_progress" });
  const { root, status } = await currentUpdateCheckLifecycle().run((signal) =>
    resolveStartupInstallStatus(false, signal),
  );
  if (status.error?.timeoutMs) {
    throw new Error(status.error.message);
  }
  await recordUpdateRunPhase(runId, "requested", {
    target: {
      ...(status.installKind === "git" || status.installKind === "package"
        ? { kind: status.installKind }
        : {}),
      ...(status.installKind === "git" ? { installationMethod: "git-checkout" } : {}),
    },
  });
  // Status discovery is read-only; admit ownership before campaign adoption
  // or a managed handoff can select and launch an updater.
  await createFreeBsdPkgOwnershipInspection(timeoutMs).assertUnowned(root);
  const installSurface = await resolveUpdateInstallSurface({
    root,
    installKind: status.installKind,
    timeoutMs,
  });
  await recordUpdateRunPhase(runId, "requested", {
    ...(installSurface.kind === "global"
      ? { target: { installationMethod: `${installSurface.mode}-global` } }
      : {}),
    step: { step: "installation-inspection", status: "completed" },
  });
  return { status, installSurface };
}

type HandoffFailureKind = Extract<keyof typeof UPDATE_PREFLIGHT_DETAILS, `handoff-${string}`>;
type HandoffFailureStage = "prepare" | "prepared" | "sentinel" | "transfer";

function classifyHandoffFailure(
  fact: ReturnType<typeof createUpdateErrorFact>,
  stage: HandoffFailureStage,
): HandoffFailureKind {
  const detail = `${fact.code} ${fact.message ?? ""}`;
  if (/\b(?:EACCES|EPERM|permission denied)\b/iu.test(detail)) {
    return "handoff-permission-denied";
  }
  if (/\b(?:ETIMEDOUT|timed out|did not (?:respond|signal readiness))\b/iu.test(detail)) {
    return "handoff-timeout";
  }
  if (
    stage === "sentinel" ||
    /\b(?:EPIPE|ENOSPC|EROFS|control input closed|invalid readiness response)\b/iu.test(detail)
  ) {
    return "handoff-payload-failed";
  }
  if (stage === "transfer") {
    return "handoff-ownership-refused";
  }
  if (/\b(?:ENOENT|ENOEXEC|executable|entrypoint)\b/iu.test(detail)) {
    return "handoff-runtime-unavailable";
  }
  if (/\b(?:spawn|EAGAIN|ENOMEM)\b/iu.test(detail)) {
    return "handoff-helper-start-failed";
  }
  if (/\b(?:launchctl|systemctl|systemd-run|bootstrap)\b/iu.test(detail)) {
    return "handoff-service-refused";
  }
  if (
    /\b(?:lease|ownership|owner|authority|requester|aborted|process (?:start )?identity)\b/iu.test(
      detail,
    )
  ) {
    return "handoff-ownership-refused";
  }
  if (/\bexited before (?:responding|signaling readiness)\b/u.test(detail)) {
    return "handoff-helper-exited";
  }
  return "handoff-preparation-failed";
}

export async function recordHandoffFailure(
  runId: string,
  error: unknown,
  previous: UpdateRunResult,
  warn: (message: string) => void,
  stage: HandoffFailureStage = "prepare",
): Promise<UpdateRunResult> {
  const cause = createUpdateErrorFact("managed-service", error);
  const classified = createUpdatePreflightFailure(
    classifyHandoffFailure(cause, stage),
    undefined,
    "managed-service",
  );
  const reason =
    error instanceof UpdatePreMutationError ? error.reason : "managed-service-handoff-failed";
  const failureFacts = [
    ...(error instanceof UpdatePreMutationError ? error.failureFacts : [cause]).slice(0, 4),
    ...classified.failureFacts,
  ];
  const rollbackOutcome =
    stage === "prepare" || stage === "sentinel"
      ? { status: "not-needed" as const, reason: UPDATE_HANDOFF_BEFORE_TRANSFER_DETAIL }
      : previous.rollbackOutcome;
  const step = {
    name: "requested",
    command: "",
    cwd: previous.root ?? "",
    durationMs: 0,
    exitCode: null,
    failureFacts,
  };
  try {
    if (error instanceof UpdatePreMutationError) {
      await recordUpdateRunPhase(runId, "requested", { origin: { nextAction: error.message } });
    }
    await recordUpdateRunStep(runId, { step: step.name, status: "failed", reason });
  } catch {
    warn("Update failure state could not be recorded; preserving the original error.");
  }
  await recordUpdateRunDiagnostics(
    runId,
    {
      rollbackOutcome,
      failure: {
        step: step.name,
        exitCode: step.exitCode,
        detail: summarizeUpdateStepFailure(step),
        failureFacts,
      },
    },
    warn,
  );
  return {
    ...previous,
    status: "error",
    reason,
    rollbackOutcome,
    steps: [...previous.steps, step],
  };
}

export async function createUnexpectedUpdateFailureResult(
  current: UpdateRunRecord,
  previous: UpdateRunResult,
  error: unknown,
  warn: (message: string) => void,
): Promise<UpdateRunResult> {
  const activeStep = current.steps.findLast((step) => step.status === "in_progress");
  const name = activeStep?.step ?? current.phase;
  const reason = error instanceof FreeBsdPkgOwnershipError ? error.reason : "unexpected-error";
  const step = {
    name,
    command: "",
    cwd: previous.root ?? "",
    durationMs: Date.now() - (activeStep?.startedAtMs ?? current.createdAtMs),
    exitCode: 1,
    failureFacts: [createUpdateErrorFact(name, error)],
  };
  const result: UpdateRunResult = {
    ...previous,
    status: "error",
    mode: previous.mode === "unknown" && current.target.kind === "git" ? "git" : previous.mode,
    reason,
    recovery: current.verification.recovery ?? previous.recovery,
    rollbackOutcome: current.verification.rollbackOutcome ??
      previous.rollbackOutcome ?? {
        status: "not-attempted",
        reason: "Gateway RPC does not perform rollback after an unexpected exception",
      },
    before: previous.before ?? current.before,
    after: previous.after ?? current.after,
    steps: [...previous.steps, step],
    durationMs: Date.now() - current.createdAtMs,
  };
  await recordUpdateRunDiagnostics(
    current.runId,
    {
      recovery: result.recovery,
      rollbackOutcome: result.rollbackOutcome,
      failure: {
        step: name,
        exitCode: step.exitCode,
        detail: summarizeUpdateStepFailure(step),
        failureFacts: step.failureFacts,
      },
    },
    warn,
  );
  return result;
}
