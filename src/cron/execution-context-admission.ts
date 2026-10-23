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
import { prepareCommandOwnerAuthority } from "../auto-reply/command-auth.js";
import { resolveAgentMainSessionKey } from "../config/sessions/main-session.js";
import { resolveSessionStorePathCore } from "../config/sessions/paths.js";
import { prepareSessionGenerationFacts } from "../config/sessions/session-delivery-generation.js";
import { readSessionEntryInWorker } from "../config/sessions/session-entry-read-runtime.js";
import type { SessionEntry } from "../config/sessions/types.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { resolveCreatorSandbox } from "../gateway/operator-role-policy.js";
import { decodeGatewayOperatorRecoverySource } from "../gateway/operator-run-recovery-source.codec.js";
import { captureResidentUserProfileAccess } from "../state/user-profile-list.js";
import {
  buildScheduledExecutionContext,
  classifyScheduledParent,
  resolveScheduledPrincipal,
  type ScheduledAdmissionFacts,
  type ScheduledExecutionContextResult,
  type ScheduledRequesterRef,
} from "./execution-context.js";
import {
  failedScheduledExecution,
  type ScheduledExecutionContext,
  type ScheduledOccurrence,
  unadmittedScheduledOccurrence,
} from "./scheduled-occurrence.js";
import { resolveCronScheduledToolPolicy } from "./scheduled-tool-policy.js";
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

/** Owner check for requesters the occurrence can verify; operator sources are checked per run. */
async function checkRequesterOwner(
  cfg: OpenClawConfig,
  requester: Exclude<ScheduledRequesterRef, { kind: "operator-source" }>,
): Promise<boolean> {
  switch (requester.kind) {
    case "channel": {
      const prepared = await prepareCommandOwnerAuthority(cfg, requester.requester);
      return prepared.source !== undefined && prepared.isCurrent(cfg);
    }
    case "profile":
      try {
        captureResidentUserProfileAccess(requester.profileId).assertCurrent();
      } catch {
        return false;
      }
      // Named roles describe team operators; only an untiered install or the
      // Gateway owner profile carries owner authority.
      return !cfg.gateway?.roles || requester.profileId === GATEWAY_OWNER_PROFILE_ID;
    case "unknown":
      return false;
  }
  return false;
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

async function readParentRow(
  parentSessionKey: string,
  storePath: string,
): Promise<NonNullable<ScheduledAdmissionFacts["parentRow"]>> {
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
  return parentRowFactsFromEntry(entry, worktreeExists);
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
  return {
    sessionId: entry.sessionId,
    ...(entry.lifecycleRevision ? { lifecycleRevision: entry.lifecycleRevision } : {}),
    archived: typeof entry.archivedAt === "number",
    ...(entry.spawnedWorkspaceDir ? { workspaceDir: entry.spawnedWorkspaceDir } : {}),
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
    ...(resolveCreatorSandbox(params.cfg, { actor: params.job.createdActor })
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
  let owner: boolean | undefined;
  let generation: Awaited<ReturnType<typeof prepareSessionGenerationFacts>> | undefined;
  let pause: CronParentUnavailable | undefined;
  try {
    if (!("error" in principal) && principal.kind === "parent") {
      const storePath = resolveSessionStorePathCore(params.cfg.session?.store, {
        agentId: params.agentId,
      });
      parentRow = await readParentRow(principal.parent.sessionKey, storePath);
      if (principal.requester.kind !== "operator-source") {
        owner = await checkRequesterOwner(params.cfg, principal.requester);
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
    }
  } catch (error) {
    generation?.release();
    return unadmittedScheduledOccurrence(error instanceof Error ? error.message : String(error));
  }
  const operatorSourceRequester =
    !("error" in principal) &&
    principal.kind === "parent" &&
    principal.requester.kind === "operator-source";
  return {
    ...(pause ? { pause } : {}),
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
          operatorSourceRequester ? run.operatorAuthorityRestored : owner,
        );
        result = buildScheduledExecutionContext(job, facts);
      } catch (error) {
        return failedScheduledExecution(error instanceof Error ? error.message : String(error));
      }
      const lease = generation;
      const assertParentCurrent =
        result.status === "ready" && result.facts.principal.kind === "parent" && lease
          ? () => lease.assertCurrent()
          : () => {};
      let context: ScheduledExecutionContext | undefined;
      return {
        result,
        bind(assertAdmitted) {
          if (result.status !== "ready") {
            return;
          }
          context = {
            ...result.facts,
            assertCurrent: () => {
              assertAdmitted();
              assertParentCurrent();
            },
          };
        },
        current: () => context,
        release() {
          context = undefined;
        },
      };
    },
    release() {
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
