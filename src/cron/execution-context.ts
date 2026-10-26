/**
 * One per-occurrence description of what a scheduled run is and what it may
 * act on. The builder is pure: callers read the parent session row and run the
 * requester check, then pass the results in as facts.
 */
import type { AdmittedRunContext } from "../agents/admitted-run-context.js";
import { isRuntimeToolAllowed } from "../agents/tool-policy-match.js";
import { AUTOMATIONS_TOOL_NAME } from "../agents/tools/automations-tool-name.js";
import type { SessionCreatedActor } from "../config/sessions/session-entry-provenance.js";
import type { CronAuthenticatedChannelRequester } from "../gateway/cron-creator-authority-grant.types.js";
import {
  decodeGatewayOperatorRecoverySource,
  type RestartRecoveryOperatorSource,
} from "../gateway/operator-run-recovery-source.codec.js";
import type { CronInferenceBinding } from "./inference-binding.js";
import { resolveCronRunAdmissionSource } from "./run-authority.js";
import type { CronRuntimeAuthority } from "./runtime-authority.js";
import {
  type CronScheduledToolCallerOrigin,
  type CronScheduledToolPolicy,
  type CronToolsAllowExecTarget,
  normalizeCronScheduledToolCallerOrigin,
  resolveCronScheduledToolPolicy,
} from "./scheduled-tool-policy.js";
import { resolveCronSessionTargetSessionKey } from "./session-target.js";
import type { CronStoredJob } from "./types.js";

type ScheduledIngress = "webhook" | "plugin-hook" | "channel-join";

type ScheduledParentRef = Readonly<{
  agentId: string;
  sessionKey: string;
  sessionId: string;
  lifecycleRevision?: string;
}>;

export type ScheduledRequesterRef =
  | Readonly<{ kind: "operator-source"; source: RestartRecoveryOperatorSource }>
  | Readonly<{ kind: "channel"; requester: CronAuthenticatedChannelRequester }>
  | Readonly<{ kind: "profile"; profileId: string }>
  | Readonly<{ kind: "unknown" }>;

type ScheduledPrincipal =
  | Readonly<{ kind: "parent"; parent: ScheduledParentRef; requester: ScheduledRequesterRef }>
  /** A parent key without its incarnation. Every decision equals the legacy one until bound. */
  | Readonly<{ kind: "unbound-parent"; parentSessionKey: string }>
  | Readonly<{ kind: "operator"; basis: "trusted-policy" | "unlinked-legacy" }>
  | Readonly<{ kind: "ingress"; ingress: ScheduledIngress }>;

type ScheduledPlacement = "child" | "in-session" | "detached";

type ScheduledAuthority = Readonly<{
  owner: boolean;
  basis:
    | "operator-source"
    | "channel-owner"
    | "profile-role"
    | "trusted-policy"
    | "legacy"
    | "none";
  /** Undefined for ingress turns, which are admitted without a schedule source. */
  admissionSource?: NonNullable<AdmittedRunContext["admissionSource"]>;
}>;

type ScheduledAutomationsScope =
  | Readonly<{ scope: "self"; jobId: string }>
  | Readonly<{ scope: "self-and-parent-wake"; jobId: string; parentSessionKey: string }>
  | Readonly<{ scope: "none" }>;

type ScheduledToolPolicy = Readonly<{
  /** Resolved run cap; undefined means the agent's own policy applies uncapped. */
  allow?: readonly string[];
  policy?: CronScheduledToolPolicy;
  callerOrigin: CronScheduledToolCallerOrigin;
  execTarget?: CronToolsAllowExecTarget;
  automations: ScheduledAutomationsScope;
}>;

type ScheduledResourceScopes = Readonly<{
  /** Which session's memory audience the run reads; the builder holds no leases. */
  memory:
    | Readonly<{ source: "parent"; parent: ScheduledParentRef; owner: boolean }>
    | Readonly<{ source: "run-session" }>;
  boardSessionKey: string;
  mediaSessionKey: string;
  eventTargetSessionKey: string;
  workspace:
    | Readonly<{ source: "parent-row"; dir: string; cwd?: string; worktreePath?: string }>
    | Readonly<{ source: "run-session" }>;
  fileScope: "root" | "session";
  bootstrap: "cron-allowlist" | "default";
  sandbox: Readonly<{
    required: boolean;
    basis: readonly ("agent-config" | "creator-role" | "parent-row")[];
  }>;
  execHost?: CronToolsAllowExecTarget;
  messageAccounts: Readonly<{
    ownerAccountId?: string;
    channelRequester?: CronAuthenticatedChannelRequester;
  }>;
  delivery: Readonly<{ sourceConversation?: CronStoredJob["sourceConversation"] }>;
}>;

type ScheduledInferenceAccount =
  | Readonly<{ kind: "bound"; binding: CronInferenceBinding }>
  | Readonly<{ kind: "runtime"; authority: CronRuntimeAuthority }>
  | Readonly<{ kind: "runtime-recovery-required" }>
  | Readonly<{ kind: "none" }>;

/** The pure part of the context; admission adds the composed live assertion. */
export type ScheduledExecutionFacts = Readonly<{
  version: 1;
  jobId: string;
  occurrence: Readonly<{ runId: string; executionRevision: string }>;
  principal: ScheduledPrincipal;
  placement: ScheduledPlacement;
  authority: ScheduledAuthority;
  toolPolicy: ScheduledToolPolicy;
  resources: ScheduledResourceScopes;
  inference: ScheduledInferenceAccount;
}>;

/** Parent row as read by the caller on the read-only worker. */
type ScheduledParentRowFacts =
  | Readonly<{ missing: true }>
  | Readonly<{
      missing?: false;
      sessionId: string;
      lifecycleRevision?: string;
      archived: boolean;
      workspaceDir?: string;
      cwd?: string;
      worktree?: Readonly<{ path: string; exists: boolean }>;
      sandboxRequired: boolean;
    }>;

export type ScheduledAdmissionFacts = Readonly<{
  trigger: "cron" | "event";
  /** Required when trigger is "event". */
  ingress?: ScheduledIngress;
  occurrence: Readonly<{ runId: string; executionRevision: string }>;
  agentId: string;
  runSessionKey: string;
  agentMainSessionKey: string;
  agentSandboxMode: "off" | "non-main" | "all";
  creatorRoleSandbox?: "required";
  /** Output of resolveCronRunToolsAllow for this occurrence. */
  resolvedToolsAllow?: readonly string[];
  /** Required for parent principals; undefined means the caller did not read it. */
  parentRow?: ScheduledParentRowFacts;
  /** Result of the requester's current owner check, by its existing owner. */
  requesterCheck?: Readonly<{ owner: boolean }>;
}>;

type ScheduledParentUnavailableReason = "removed" | "archived" | "worktree-missing";

export type ScheduledExecutionContextResult =
  | Readonly<{ status: "ready"; facts: ScheduledExecutionFacts }>
  | Readonly<{
      status: "pause";
      reason: ScheduledParentUnavailableReason;
      parentSessionKey: string;
      worktreePath?: string;
    }>
  | Readonly<{ status: "fail"; error: string }>;

type BuilderJob = Pick<
  CronStoredJob,
  | "id"
  | "sessionTarget"
  | "owner"
  | "scheduledToolPolicy"
  | "payload"
  | "operatorSource"
  | "sourceConversation"
  | "createdActor"
  | "toolsAllowProvenance"
  | "toolsAllowExecTarget"
  | "inferenceBinding"
  | "runtimeAuthority"
  | "runtimeAuthorityRecoveryRequired"
>;

/** Which requester an occurrence must recheck; the caller runs that owner's check. */
export function resolveScheduledRequester(
  job: Pick<CronStoredJob, "operatorSource" | "toolsAllowProvenance" | "createdActor">,
): ScheduledRequesterRef {
  if (job.operatorSource) {
    return {
      kind: "operator-source",
      source: decodeGatewayOperatorRecoverySource(job.operatorSource.source),
    };
  }
  const channelRequester = job.toolsAllowProvenance?.channelRequester;
  if (channelRequester) {
    return { kind: "channel", requester: channelRequester };
  }
  const profileId = profileIdOf(job.createdActor);
  // The parent row's creator records who opened the conversation, not who
  // authorized this job, so it is never a fallback.
  return profileId ? { kind: "profile", profileId } : { kind: "unknown" };
}

function profileIdOf(actor: SessionCreatedActor | undefined) {
  return actor?.type === "human" && actor.source === "profile" ? actor.id : undefined;
}

/** The occurrence's principal; occurrence admission and the builder share this resolution. */
export function resolveScheduledPrincipal(
  job: BuilderJob,
  facts: Pick<ScheduledAdmissionFacts, "trigger" | "ingress" | "agentId">,
): ScheduledPrincipal | { error: string } {
  if (facts.trigger === "event") {
    return facts.ingress
      ? { kind: "ingress", ingress: facts.ingress }
      : { error: "event-triggered runs must name their ingress" };
  }
  if (job.operatorSource) {
    let source: RestartRecoveryOperatorSource;
    try {
      source = decodeGatewayOperatorRecoverySource(job.operatorSource.source);
    } catch {
      return { error: "stored operator source is invalid" };
    }
    return {
      kind: "parent",
      parent: {
        agentId: source.agentId,
        sessionKey: source.sessionKey,
        sessionId: source.sessionId,
        ...(source.lifecycleRevision ? { lifecycleRevision: source.lifecycleRevision } : {}),
      },
      requester: { kind: "operator-source", source },
    };
  }
  const source = job.sourceConversation;
  if (source) {
    return {
      kind: "parent",
      parent: {
        agentId: facts.agentId,
        sessionKey: source.sessionKey,
        sessionId: source.sessionId,
        ...(source.lifecycleRevision ? { lifecycleRevision: source.lifecycleRevision } : {}),
      },
      requester: resolveScheduledRequester(job),
    };
  }
  const policy = job.scheduledToolPolicy;
  const parentKey =
    (policy?.mode === "account" ? policy.ownerSessionKey : undefined) ?? job.owner?.sessionKey;
  if (parentKey && policy?.mode !== "trusted") {
    return { kind: "unbound-parent", parentSessionKey: parentKey };
  }
  return {
    kind: "operator",
    basis: policy?.mode === "trusted" ? "trusted-policy" : "unlinked-legacy",
  };
}

export function classifyScheduledParent(
  parent: ScheduledParentRef,
  row: ScheduledParentRowFacts | undefined,
): ScheduledParentUnavailableReason | "reset" | "current" | "unread" {
  if (!row) {
    return "unread";
  }
  if (row.missing) {
    return "removed";
  }
  if (row.archived) {
    return "archived";
  }
  // A link stored without a lifecycle revision can only prove the session id.
  if (
    row.sessionId !== parent.sessionId ||
    (parent.lifecycleRevision !== undefined && row.lifecycleRevision !== parent.lifecycleRevision)
  ) {
    return "reset";
  }
  return "current";
}

function resolveAuthority(
  job: BuilderJob,
  principal: ScheduledPrincipal,
  facts: ScheduledAdmissionFacts,
): ScheduledAuthority {
  const admissionSource = facts.trigger === "cron" ? resolveCronRunAdmissionSource(job) : undefined;
  const withSource = (owner: boolean, basis: ScheduledAuthority["basis"]): ScheduledAuthority => ({
    owner,
    basis,
    ...(admissionSource ? { admissionSource } : {}),
  });
  if (principal.kind === "parent") {
    const { requester } = principal;
    if (requester.kind === "unknown") {
      // v2026.10.6 recorded a trusted policy, but no requester, for jobs an
      // authenticated operator linked with `cron.add --session-key`; agents never
      // get one. Those runs keep the operator surface they had, like an unlinked
      // trusted job. Agent-created jobs with no requester stay non-owners.
      return job.scheduledToolPolicy?.mode === "trusted"
        ? withSource(true, "trusted-policy")
        : withSource(false, "none");
    }
    // A missing check fails closed: the caller owns running it each occurrence.
    const owner = facts.requesterCheck?.owner === true;
    const basis =
      requester.kind === "operator-source"
        ? "operator-source"
        : requester.kind === "channel"
          ? "channel-owner"
          : "profile-role";
    return withSource(owner, owner ? basis : "none");
  }
  if (principal.kind === "unbound-parent" || principal.kind === "operator") {
    // Legacy embedded runs pass no sender bit, which keeps owner-only tools.
    return withSource(true, "legacy");
  }
  // Ingress turns carry no owner authority.
  return withSource(false, "none");
}

function resolvePlacement(job: BuilderJob, principal: ScheduledPrincipal): ScheduledPlacement {
  // `main` runs as a scheduled turn inside the agent's main session, like `session:<key>`.
  if (job.sessionTarget === "main" || resolveCronSessionTargetSessionKey(job.sessionTarget)) {
    return "in-session";
  }
  return principal.kind === "parent" ? "child" : "detached";
}

function resolveAutomationsScope(
  job: BuilderJob,
  principal: ScheduledPrincipal,
  authority: ScheduledAuthority,
  allow: readonly string[] | undefined,
): ScheduledAutomationsScope {
  if (!isRuntimeToolAllowed(AUTOMATIONS_TOOL_NAME, allow)) {
    return { scope: "none" };
  }
  if (principal.kind === "parent" && authority.owner) {
    return {
      scope: "self-and-parent-wake",
      jobId: job.id,
      parentSessionKey: principal.parent.sessionKey,
    };
  }
  return { scope: "self", jobId: job.id };
}

function resolveInference(job: BuilderJob): ScheduledInferenceAccount {
  if (job.inferenceBinding) {
    return { kind: "bound", binding: job.inferenceBinding };
  }
  if (job.runtimeAuthority) {
    return { kind: "runtime", authority: job.runtimeAuthority };
  }
  if (job.runtimeAuthorityRecoveryRequired) {
    return { kind: "runtime-recovery-required" };
  }
  return { kind: "none" };
}

/** Builds the execution facts for one occurrence from stored fields and admission facts. */
export function buildScheduledExecutionContext(
  job: BuilderJob,
  facts: ScheduledAdmissionFacts,
): ScheduledExecutionContextResult {
  const resolved = resolveScheduledPrincipal(job, facts);
  if ("error" in resolved) {
    return { status: "fail", error: resolved.error };
  }
  const state =
    resolved.kind === "parent"
      ? classifyScheduledParent(resolved.parent, facts.parentRow)
      : "current";
  if (state === "unread") {
    return { status: "fail", error: "parent session facts are required for a parent-linked job" };
  }
  if (resolved.kind === "parent" && state !== "current" && state !== "reset") {
    return { status: "pause", reason: state, parentSessionKey: resolved.parent.sessionKey };
  }
  // A reset keeps the automation running, but nothing carries into the new
  // incarnation: this occurrence takes the legacy decisions until rebound.
  const principal: ScheduledPrincipal =
    resolved.kind === "parent" && state === "reset"
      ? { kind: "unbound-parent", parentSessionKey: resolved.parent.sessionKey }
      : resolved;
  const parentRow = principal.kind === "parent" ? facts.parentRow : undefined;
  const liveRow = parentRow && !parentRow.missing ? parentRow : undefined;
  if (liveRow?.worktree && !liveRow.worktree.exists && principal.kind === "parent") {
    return {
      status: "pause",
      reason: "worktree-missing",
      parentSessionKey: principal.parent.sessionKey,
      worktreePath: liveRow.worktree.path,
    };
  }

  const placement = resolvePlacement(job, principal);
  const authority = resolveAuthority(job, principal, facts);
  const allow =
    facts.resolvedToolsAllow ??
    (job.payload.kind === "agentTurn" ? job.payload.toolsAllow : undefined);
  const policy = resolveCronScheduledToolPolicy({
    toolsAllow: job.payload.kind === "agentTurn" ? job.payload.toolsAllow : undefined,
    scheduledToolPolicy: job.scheduledToolPolicy,
    owner: job.owner,
  });
  const childOfParent = principal.kind === "parent" && placement === "child";
  const detached = placement === "detached";
  const resourceSessionKey = childOfParent ? principal.parent.sessionKey : facts.runSessionKey;

  const sandboxBasis: ("agent-config" | "creator-role" | "parent-row")[] = [];
  if (
    facts.agentSandboxMode === "all" ||
    (facts.agentSandboxMode === "non-main" && facts.runSessionKey !== facts.agentMainSessionKey)
  ) {
    sandboxBasis.push("agent-config");
  }
  if (facts.creatorRoleSandbox === "required") {
    sandboxBasis.push("creator-role");
  }
  if (liveRow?.sandboxRequired) {
    sandboxBasis.push("parent-row");
  }

  const channelRequester = job.toolsAllowProvenance?.channelRequester;
  const ownerAccountId = policy?.mode === "account" ? policy.ownerAccountId : undefined;

  return {
    status: "ready",
    facts: {
      version: 1,
      jobId: job.id,
      occurrence: facts.occurrence,
      principal,
      placement,
      authority,
      toolPolicy: {
        ...(allow ? { allow } : {}),
        ...(policy ? { policy } : {}),
        callerOrigin: normalizeCronScheduledToolCallerOrigin(
          job.toolsAllowProvenance?.callerOrigin,
        ),
        ...(job.toolsAllowExecTarget ? { execTarget: job.toolsAllowExecTarget } : {}),
        automations: resolveAutomationsScope(job, principal, authority, allow),
      },
      resources: {
        memory:
          principal.kind === "parent"
            ? { source: "parent", parent: principal.parent, owner: authority.owner }
            : { source: "run-session" },
        boardSessionKey: resourceSessionKey,
        mediaSessionKey: resourceSessionKey,
        // Detached runs without a parent keep the existing main-session redirect.
        eventTargetSessionKey: detached ? facts.agentMainSessionKey : resourceSessionKey,
        workspace:
          childOfParent && liveRow?.workspaceDir
            ? {
                source: "parent-row",
                dir: liveRow.workspaceDir,
                ...(liveRow.cwd ? { cwd: liveRow.cwd } : {}),
                ...(liveRow.worktree ? { worktreePath: liveRow.worktree.path } : {}),
              }
            : { source: "run-session" },
        // Only an in-session run uses its session's file scope; child runs stay at root.
        fileScope: placement === "in-session" ? "session" : "root",
        bootstrap: detached ? "cron-allowlist" : "default",
        sandbox: { required: sandboxBasis.length > 0, basis: sandboxBasis },
        ...(job.toolsAllowExecTarget ? { execHost: job.toolsAllowExecTarget } : {}),
        messageAccounts: {
          ...(ownerAccountId ? { ownerAccountId } : {}),
          ...(channelRequester ? { channelRequester } : {}),
        },
        delivery: job.sourceConversation ? { sourceConversation: job.sourceConversation } : {},
      },
      inference: resolveInference(job),
    },
  };
}
