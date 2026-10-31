import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import {
  ErrorCodes,
  errorShape,
  GatewayErrorDetailCodes,
} from "../../../packages/gateway-protocol/src/index.js";
import { cronJobUsesToolRuntime } from "../../cron/tools-allow.js";
import type { CronJob, CronJobPatch } from "../../cron/types.js";
import {
  createAgentDatabaseAdmissionErrorShape,
  readAgentDatabaseAdmissionRefusal,
} from "../../state/agent-database-admission.js";
import { assertActiveAgentRuntimeAuthority } from "./agent-runtime-authority.js";
import {
  cronJobMatchesCallerScope,
  cronTrustedJobOwnedByCaller,
  readCronCallerScope,
  type CronCallerScope,
} from "./cron-caller-scope.js";
import { requiresExplicitAgentRuntimeToolsAllow } from "./cron-input-validation.js";
import { createCronSessionVisibility, cronJobIsVisible } from "./cron-visibility.js";
import type { GatewayRequestHandler, GatewayRequestHandlerOptions, RespondFn } from "./types.js";
import { defineValidatedGatewayHandler, type Validator } from "./validation.js";

type CronJobIdParams = { id?: string; jobId?: string };

function isLegacyCreatorPromptUpdate(job: CronJob, patch: CronJobPatch): boolean {
  // A prompt edit keeps the legacy execution policy; it cannot establish new
  // authority or transfer management to another session/account.
  return (
    job.scheduledToolPolicy === undefined &&
    job.payload.kind === "agentTurn" &&
    patch.payload !== undefined &&
    (patch.payload.kind === undefined || patch.payload.kind === "agentTurn") &&
    Object.keys(patch).every((key) => key === "payload") &&
    Object.keys(patch.payload).every((key) => key === "kind" || key === "message")
  );
}

/** Plain refusal a scoped model caller can act on when a tool-runtime edit needs ownership. */
export function resolveCronScopedToolEditRefusal(params: {
  job: CronJob;
  nextJob: CronJob;
  patch: CronJobPatch;
  callerScope: CronCallerScope | undefined;
}): string | undefined {
  const { job, nextJob, patch, callerScope } = params;
  if (!callerScope || callerScope.manageAll || !cronJobUsesToolRuntime(nextJob)) {
    return undefined;
  }
  const ownedByCaller =
    callerScope.sessionKey !== undefined &&
    job.owner?.sessionKey === callerScope.sessionKey &&
    job.owner?.accountId === callerScope.accountId;
  // A payload or trigger edit runs with the job's tool authority, so only the
  // recorded owner may make it; other jobs need a Gateway owner or operator.
  if (!ownedByCaller) {
    return job.owner?.sessionKey
      ? "This automation belongs to another conversation or account. Only its owner, a Gateway " +
          "owner or an operator can change its prompt or tools; you can create a new automation here instead."
      : "This automation has no recorded owner, so only a Gateway owner or an operator can change " +
          "its prompt or tools (for example on the Automations page). You can still enable, " +
          "disable, reschedule or remove it, or create a new automation here.";
  }
  return requiresExplicitAgentRuntimeToolsAllow({ job: nextJob, callerScope }) &&
    !isLegacyCreatorPromptUpdate(job, patch)
    ? "Include payload.toolsAllow listing the tools this automation needs (use [] for none)."
    : undefined;
}

// Only these fields keep a trusted job's operator authority when a scoped conversation edits it.
// `name` is excluded: the run prompt includes it.
const TRUSTED_LIFECYCLE_PATCH_KEYS: ReadonlySet<string> = new Set([
  "enabled",
  "schedule",
  "displayName",
  "description",
  "deleteAfterRun",
  "wakeMode",
  "pacing",
  "activeHours",
  "idleOnly",
]);

/** Any other edit (prompt, tools, routes, failure alerts, future fields) narrows the job to the caller. */
export function cronUpdateNarrowsTrustedJob(
  job: CronJob,
  patch: CronJobPatch,
  callerScope: CronCallerScope | undefined,
): boolean {
  return (
    job.scheduledToolPolicy?.mode === "trusted" &&
    callerScope !== undefined &&
    !callerScope.manageAll &&
    Object.keys(patch).some((key) => !TRUSTED_LIFECYCLE_PATCH_KEYS.has(key))
  );
}

/** Narrowing needs the owner's proven account; legacy owner records keep lifecycle edits only. */
export function assertTrustedJobNarrowingOwner(
  job: CronJob,
  callerScope: CronCallerScope | undefined,
): void {
  if (!callerScope || !cronTrustedJobOwnedByCaller(job, callerScope, { requireAccount: true })) {
    throw new TypeError(
      "This automation runs with operator access and its owner record has no account, so from " +
        "here you can only pause, resume, reschedule or remove it. To change what it runs or its name, " +
        "where it reports or where failures alert, create a new automation here or use the Automations page.",
    );
  }
}

export function respondRefusedCronAgent(agentId: string | undefined, respond: RespondFn): boolean {
  const refusal = agentId ? readAgentDatabaseAdmissionRefusal(agentId) : undefined;
  if (!refusal) {
    return false;
  }
  respond(false, undefined, createAgentDatabaseAdmissionErrorShape(refusal));
  return true;
}

export function assertCronReadCurrent(
  options: Pick<
    GatewayRequestHandlerOptions,
    "client" | "context" | "signal" | "hasCurrentClientAuthority"
  >,
) {
  options.signal?.throwIfAborted();
  if (options.hasCurrentClientAuthority?.() === false) {
    throw new Error("Cron history authority closed");
  }
  assertActiveAgentRuntimeAuthority(options.client, options.context);
}

export function resolveCronJobId(params: CronJobIdParams): string | undefined {
  // Exact store lookups; clipboard/UI padding must not fake "id not found".
  return normalizeOptionalString(params.id ?? params.jobId);
}

export function respondInvalidCronParams(respond: RespondFn, method: string, reason: string): void {
  respond(
    false,
    undefined,
    errorShape(ErrorCodes.INVALID_REQUEST, `invalid ${method} params: ${reason}`),
  );
}

export function respondMissingCronJobId(respond: RespondFn, method: string): void {
  respondInvalidCronParams(respond, method, "missing id");
}

export function respondCronJobNotFound(
  respond: RespondFn,
  jobId: string,
  options: { preserveCronGetWireMessage?: boolean } = {},
): void {
  const message = options.preserveCronGetWireMessage
    ? `cron job not found: ${jobId}. List automations and retry with a current job id.`
    : `Automation not found: ${jobId}. List automations and retry with a current job id.`;
  respond(
    false,
    undefined,
    errorShape(
      ErrorCodes.INVALID_REQUEST,
      `${message} For cross-session management, use a fresh authenticated configured channel owner or Control UI administrator turn or the Automations page.`,
      {
        details: { code: GatewayErrorDetailCodes.CRON_JOB_NOT_FOUND, jobId },
      },
    ),
  );
}

type ScopedCronMethod =
  | "cron.get"
  | "cron.liveOutput"
  | "cron.scratch.get"
  | "cron.scratch.set"
  | "cron.remove"
  | "cron.run";

export function scopedCronJobHandler<P extends CronJobIdParams>(
  method: ScopedCronMethod,
  validate: Validator<P>,
  run: (
    options: Omit<GatewayRequestHandlerOptions, "params"> & {
      params: P;
    },
    loaded: { jobId: string; callerScope: CronCallerScope | undefined; job: CronJob },
  ) => ReturnType<GatewayRequestHandler>,
  scope: {
    allowCurrentJob?: boolean;
    checkVisibility?: boolean;
    preserveCronGetWireMessage?: boolean;
  } = {},
): GatewayRequestHandler {
  return defineValidatedGatewayHandler(method, validate, async (options) => {
    const { params, respond, client, context } = options;
    const jobId = resolveCronJobId(params);
    if (!jobId) {
      respondMissingCronJobId(respond, method);
      return;
    }
    const visibilityRead = createCronSessionVisibility(client, context);
    const loaded = await context.cron.readJob(jobId);
    const prepareVisibility = scope.checkVisibility && visibilityRead.resolve() !== undefined;
    if (prepareVisibility) {
      await visibilityRead.prepare();
    }
    if (scope.checkVisibility) {
      assertCronReadCurrent(options);
    }
    const callerScope = readCronCallerScope(client);
    const job = prepareVisibility ? context.cron.getJob(jobId) : loaded;
    const visibility = scope.checkVisibility ? visibilityRead.resolve() : undefined;
    if (
      !job ||
      (scope.checkVisibility &&
        !cronJobIsVisible(job, visibility, context.cron.getDefaultAgentId())) ||
      !cronJobMatchesCallerScope({
        job,
        callerScope,
        defaultAgentId: context.cron.getDefaultAgentId(),
        allowCurrentJob: scope.allowCurrentJob,
      })
    ) {
      respondCronJobNotFound(respond, jobId, scope);
      return;
    }
    // Consume authorized reads in this frame; mutations retain their lock-time commit guards.
    return await run(options, { jobId, callerScope, job });
  });
}
