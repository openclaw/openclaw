/**
 * Admits one scheduled occurrence: reads the parent row once, runs the
 * requester's owner check and holds the parent generation for the whole
 * occurrence. Each admitted run then mints its context from those facts. A
 * failure here never fails the run.
 */
import { access } from "node:fs/promises";
import { GATEWAY_OWNER_PROFILE_ID } from "../../packages/gateway-protocol/src/schema/user-profile-constants.js";
import { resolveSandboxConfigForAgent } from "../agents/sandbox/config.js";
import { resolveScheduledToolPolicyContext } from "../agents/scheduled-tool-policy.js";
import { resolveIngressWorkspaceOverrideForSessionRun } from "../agents/spawned-context.js";
import { prepareCommandOwnerAuthority } from "../auto-reply/command-auth.js";
import { selectLiveRuntimeConfig } from "../config/runtime-snapshot.js";
import { resolveAgentMainSessionKey } from "../config/sessions/main-session.js";
import { resolveSessionStorePathCore } from "../config/sessions/paths.js";
import { prepareSessionGenerationFacts } from "../config/sessions/session-delivery-generation.js";
import { readSessionEntryInWorker } from "../config/sessions/session-entry-read-runtime.js";
import type { SessionEntry } from "../config/sessions/types.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { resolveCreatorSandbox } from "../gateway/operator-role-policy.js";
import { decodeGatewayOperatorRecoverySource } from "../gateway/operator-run-recovery-source.codec.js";
import { captureResidentUserProfileAccess } from "../state/user-profile-list.js";
import { bindScheduledExecutionContext } from "./execution-context-registry.js";
import {
  buildScheduledExecutionContext,
  classifyScheduledParent,
  resolveScheduledPrincipal,
  type ScheduledAdmissionFacts,
  type ScheduledExecutionContextResult,
  type ScheduledRequesterRef,
} from "./execution-context.js";
import { type ParentResetWatch, watchParentReset } from "./parent-reset-watch.js";
import {
  failedScheduledExecution,
  type ScheduledExecutionContext,
  type ScheduledOccurrence,
  unadmittedScheduledOccurrence,
} from "./scheduled-occurrence.js";
import { resolveCronScheduledToolPolicy } from "./scheduled-tool-policy.js";
import { resolveCronSessionTargetSessionKey } from "./session-target.js";
import type { CronParentUnavailable, CronStoredJob } from "./types.js";

type OccurrenceAdmissionParams = {
  cfg: OpenClawConfig;
  job: CronStoredJob;
  agentId: string;
  trigger: "cron" | "event";
  /** Event-triggered runs name their ingress boundary. */
  ingressBoundary?: string;
};

function ingressFor(boundary: string | undefined): ScheduledAdmissionFacts["ingress"] {
  if (boundary === "gateway.hooks.plugin") {
    return "plugin-hook";
  }
  return boundary === "gateway.hooks.agent" ? "webhook" : "channel-join";
}

/** A requester's owner status at admission, plus its live recheck for owner-only effects. */
type RequesterOwnerCheck = Readonly<{ owner: boolean; assertCurrent?: () => void }>;

const NOT_OWNER: RequesterOwnerCheck = { owner: false };

// Owner status from a recheck that reads current config; the recheck throws once it fails.
function ownerCheck(cfg: OpenClawConfig, isOwner: (current: OpenClawConfig) => boolean) {
  if (!isOwner(cfg)) {
    return NOT_OWNER;
  }
  return {
    owner: true,
    assertCurrent: () => {
      if (!isOwner(selectLiveRuntimeConfig(cfg))) {
        throw new Error("The requester that authorized this automation is no longer an owner.");
      }
    },
  };
}

/** Owner check for requesters the occurrence can verify; operator sources are checked per run. */
async function checkRequesterOwner(
  cfg: OpenClawConfig,
  requester: Exclude<ScheduledRequesterRef, { kind: "operator-source" }>,
): Promise<RequesterOwnerCheck> {
  switch (requester.kind) {
    case "channel": {
      // The stored envelope's version would select the recovery-reference branch; pass
      // only the native sender identity so configured and linked owners are rechecked.
      const { channel, accountId, senderId } = requester.requester;
      const prepared = await prepareCommandOwnerAuthority(cfg, { channel, accountId, senderId });
      return ownerCheck(
        cfg,
        (current) => prepared.source !== undefined && prepared.isCurrent(current),
      );
    }
    case "profile": {
      let profileAccess: ReturnType<typeof captureResidentUserProfileAccess>;
      try {
        profileAccess = captureResidentUserProfileAccess(requester.profileId);
      } catch {
        return NOT_OWNER;
      }
      // Named roles describe team operators; only an untiered install or the
      // Gateway owner profile carries owner authority.
      return ownerCheck(cfg, (current) => {
        try {
          profileAccess.assertCurrent();
        } catch {
          return false;
        }
        return !current.gateway?.roles || requester.profileId === GATEWAY_OWNER_PROFILE_ID;
      });
    }
    case "unknown":
      return NOT_OWNER;
  }
  return NOT_OWNER;
}

type ScheduledParentLink = Readonly<{
  sessionKey: string;
  sessionId: string;
  lifecycleRevision?: string;
}>;

/**
 * The stored parent link, with the builder's principal precedence: the operator
 * source names the exact incarnation, then the creating conversation. Shared with
 * the development replay.
 */
export function scheduledParentLinkOf(job: CronStoredJob): ScheduledParentLink | undefined {
  if (job.operatorSource) {
    try {
      return decodeGatewayOperatorRecoverySource(job.operatorSource.source);
    } catch {
      return undefined;
    }
  }
  return job.sourceConversation;
}

async function readParent(parentSessionKey: string, storePath: string) {
  const entry = await readSessionEntryInWorker({
    sessionKey: parentSessionKey,
    storePath,
    readConsistency: "latest",
  });
  const worktreePath = entry?.worktree ? entry.spawnedCwd : undefined;
  const worktreeExists = worktreePath
    ? await access(worktreePath).then(
        () => true,
        () => false,
      )
    : false;
  return { entry, row: parentRowFactsFromEntry(entry, worktreeExists) };
}

type ParentEntry = Pick<
  SessionEntry,
  | "sessionId"
  | "lifecycleRevision"
  | "archivedAt"
  | "spawnedWorkspaceDir"
  | "spawnedCwd"
  | "worktree"
  | "sandbox"
  | "spawnedBy"
>;

/** Builder facts for a parent session row; shared with the development replay. */
export function parentRowFactsFromEntry(
  entry: ParentEntry | undefined,
  worktreeExists: boolean,
): NonNullable<ScheduledAdmissionFacts["parentRow"]> {
  if (!entry?.sessionId) {
    return { missing: true };
  }
  const worktreePath = entry.worktree ? entry.spawnedCwd : undefined;
  const workspaceDir = resolveIngressWorkspaceOverrideForSessionRun({
    spawnedBy: entry.spawnedBy,
    workspaceDir: entry.spawnedWorkspaceDir,
    cwd: entry.spawnedCwd,
  });
  return {
    sessionId: entry.sessionId,
    ...(entry.lifecycleRevision ? { lifecycleRevision: entry.lifecycleRevision } : {}),
    archived: typeof entry.archivedAt === "number",
    // The same persisted-binding rule run preparation applies to the parent's row.
    ...(workspaceDir ? { workspaceDir } : {}),
    ...(entry.spawnedCwd ? { cwd: entry.spawnedCwd } : {}),
    ...(worktreePath ? { worktree: { path: worktreePath, exists: worktreeExists } } : {}),
    sandboxRequired: entry.sandbox === "required",
  };
}

/** Admission facts from already-read inputs; shared with the development replay. */
export function assembleScheduledAdmissionFacts(
  params: {
    cfg: OpenClawConfig;
    job: CronStoredJob;
    trigger: "cron" | "event";
    ingressBoundary?: string;
    runId: string;
    agentId: string;
    runSessionKey: string;
    toolsAllow?: readonly string[];
    /** The creator role's sandbox, when the caller read it without the resident profile catalog. */
    creatorRoleSandbox?: "required" | "none";
  },
  parentRow: ScheduledAdmissionFacts["parentRow"],
  owner: boolean | undefined,
): ScheduledAdmissionFacts {
  return {
    trigger: params.trigger,
    ...(params.trigger === "event" ? { ingress: ingressFor(params.ingressBoundary) } : {}),
    occurrence: {
      runId: params.runId,
      executionRevision: params.job.operatorSource?.executionRevision ?? "",
    },
    agentId: params.agentId,
    runSessionKey: params.runSessionKey,
    agentMainSessionKey: resolveAgentMainSessionKey({ cfg: params.cfg, agentId: params.agentId }),
    agentSandboxMode: resolveSandboxConfigForAgent(params.cfg, params.agentId).mode,
    ...((params.creatorRoleSandbox ??
      resolveCreatorSandbox(params.cfg, { actor: params.job.createdActor })) === "required"
      ? { creatorRoleSandbox: "required" as const }
      : {}),
    ...(params.toolsAllow ? { resolvedToolsAllow: params.toolsAllow } : {}),
    ...(parentRow ? { parentRow } : {}),
    ...(owner !== undefined ? { requesterCheck: { owner } } : {}),
  };
}

/**
 * Admits one occurrence. The single call site for stored jobs is the cron
 * service's `executeJobCore`; hook and join-intro turns admit with
 * `trigger: "event"`. Errors become `fail` results for every run it mints.
 */
export async function admitScheduledOccurrence(
  params: OccurrenceAdmissionParams,
): Promise<ScheduledOccurrence> {
  const { job } = params;
  const principal = resolveScheduledPrincipal(job, {
    trigger: params.trigger,
    ...(params.trigger === "event" ? { ingress: ingressFor(params.ingressBoundary) } : {}),
    agentId: params.agentId,
  });
  let parentRow: ScheduledAdmissionFacts["parentRow"];
  let requesterOwner: RequesterOwnerCheck | undefined;
  let generation: Awaited<ReturnType<typeof prepareSessionGenerationFacts>> | undefined;
  let pause: CronParentUnavailable | undefined;
  let childParent: ScheduledOccurrence["childParent"];
  let parentWatch: ParentResetWatch | undefined;
  try {
    if (!("error" in principal) && principal.kind === "parent") {
      const storePath = resolveSessionStorePathCore(params.cfg.session?.store, {
        agentId: params.agentId,
      });
      const parent = await readParent(principal.parent.sessionKey, storePath);
      parentRow = parent.row;
      if (principal.requester.kind !== "operator-source") {
        requesterOwner = await checkRequesterOwner(params.cfg, principal.requester);
      }
      const parentState = classifyScheduledParent(principal.parent, parentRow);
      const parentSessionKey = principal.parent.sessionKey;
      // A reset parent keeps running as an unbound parent; a failed read never pauses.
      if (parentState === "removed" || parentState === "archived") {
        pause = { reason: parentState, parentSessionKey };
      } else if (
        parentState === "current" &&
        !parentRow.missing &&
        parentRow.worktree &&
        !parentRow.worktree.exists
      ) {
        pause = {
          reason: "worktree-missing",
          parentSessionKey,
          worktreePath: parentRow.worktree.path,
        };
      }
      // A child run takes its parent's persisted workspace binding and never runs
      // looser than its parent; in-session runs keep their own session's binding.
      const childPlacement =
        job.sessionTarget !== "main" && !resolveCronSessionTargetSessionKey(job.sessionTarget);
      if (parentState === "current" && !pause && childPlacement && parent.entry) {
        const entry = parent.entry;
        const bindsWorkspace = Boolean(
          !parentRow.missing && (parentRow.workspaceDir || parentRow.cwd || parentRow.worktree),
        );
        childParent = {
          ...(bindsWorkspace ? { binding: { sessionKey: parentSessionKey, entry } } : {}),
          ...(entry.sandbox === "required" ? { sandbox: "required" as const } : {}),
          // Reads the lease at call time: it fails once the parent resets or the occurrence settles.
          assertCurrent: () => {
            if (!generation) {
              throw new Error("Scheduled occurrence has settled");
            }
            generation.assertCurrent();
          },
        };
      }
      if (parentState === "current") {
        // A revisionless link holds the generation classification just validated.
        const observedRevision = parentRow.missing ? undefined : parentRow.lifecycleRevision;
        generation = await prepareSessionGenerationFacts({
          agentId: params.agentId,
          storePath,
          sessionKey: principal.parent.sessionKey,
          sessionId: principal.parent.sessionId,
          lifecycleRevision: principal.parent.lifecycleRevision ?? observedRevision ?? null,
        });
      }
      // A child working in its parent's workspace must also stop work that never
      // reaches a tool check, such as a CLI process's native file tools.
      if (childParent?.binding && generation) {
        parentWatch = watchParentReset({
          parentSessionKey: principal.parent.sessionKey,
          assertCurrent: childParent.assertCurrent,
        });
        childParent = { ...childParent, signal: parentWatch.signal };
      }
    }
  } catch (error) {
    parentWatch?.stop();
    generation?.release();
    return unadmittedScheduledOccurrence(error instanceof Error ? error.message : String(error));
  }
  const operatorSourceRequester =
    !("error" in principal) &&
    principal.kind === "parent" &&
    principal.requester.kind === "operator-source";
  return {
    ...(pause ? { pause } : {}),
    ...(childParent ? { childParent } : {}),
    mint(run) {
      let result: ScheduledExecutionContextResult;
      try {
        const facts = assembleScheduledAdmissionFacts(
          {
            cfg: run.cfg,
            job,
            trigger: params.trigger,
            ingressBoundary: params.ingressBoundary,
            runId: run.runId,
            agentId: run.agentId,
            runSessionKey: run.runSessionKey,
            toolsAllow: run.toolsAllow,
          },
          parentRow,
          operatorSourceRequester ? run.operatorAuthority !== undefined : requesterOwner?.owner,
        );
        result = buildScheduledExecutionContext(job, facts);
      } catch (error) {
        return failedScheduledExecution(error instanceof Error ? error.message : String(error));
      }
      const lease = generation;
      // A requester-held owner bit is rechecked before owner-only effects. Legacy and
      // trusted-policy owners have no requester to recheck; non-owners have no
      // owner-only tools to guard.
      const operatorAuthority = run.operatorAuthority;
      const ownerRecheck =
        result.status !== "ready" ||
        !result.facts.authority.owner ||
        result.facts.authority.basis === "legacy" ||
        result.facts.authority.basis === "trusted-policy"
          ? undefined
          : operatorSourceRequester
            ? operatorAuthority && (() => operatorAuthority.assertCurrent())
            : requesterOwner?.assertCurrent;
      const assertParentCurrent =
        result.status === "ready" && result.facts.principal.kind === "parent" && lease
          ? () => lease.assertCurrent()
          : () => {};
      let context: ScheduledExecutionContext | undefined;
      let unbind = () => {};
      return {
        result,
        bind(admittedRun, assertAdmitted) {
          if (result.status !== "ready") {
            return;
          }
          // Tools built for the run keep this assertion, so it must also fail once the run settles.
          let released = false;
          context = {
            ...result.facts,
            assertCurrent: () => {
              if (released) {
                throw new Error("Scheduled occurrence has settled");
              }
              assertAdmitted();
              assertParentCurrent();
            },
            ...(ownerRecheck
              ? {
                  assertOwnerCurrent: () => {
                    if (released) {
                      throw new Error("Scheduled occurrence has settled");
                    }
                    ownerRecheck();
                  },
                }
              : {}),
          };
          const unbindContext = bindScheduledExecutionContext(admittedRun, context);
          unbind = () => {
            released = true;
            unbindContext();
          };
        },
        current: () => context,
        release() {
          unbind();
          unbind = () => {};
          context = undefined;
        },
      };
    },
    release() {
      parentWatch?.stop();
      parentWatch = undefined;
      generation?.release();
      generation = undefined;
    },
  };
}

/** The prompt executor's scheduled tool policy, from the job's stored authority fields. */
export function resolveCronJobToolPolicyContext(
  job: CronStoredJob,
  toolsAllow: string[] | undefined,
) {
  return resolveScheduledToolPolicyContext({
    toolsAllow,
    scheduledToolPolicy: resolveCronScheduledToolPolicy({
      toolsAllow,
      scheduledToolPolicy: job.scheduledToolPolicy,
      owner: job.owner,
    }),
    callerOrigin: job.toolsAllowProvenance?.callerOrigin,
    execTarget: job.toolsAllowExecTarget,
  });
}
