// Doctor's read-only scheduled-run access review: reads stored automations and
// the conversations they name, builds each one's execution context, and notes
// what changes. It never writes state or sends anything.
import { access } from "node:fs/promises";
import { GATEWAY_OWNER_PROFILE_ID } from "../../../../packages/gateway-protocol/src/schema/user-profile-constants.js";
import { note } from "../../../../packages/terminal-core/src/note.js";
import { tryResolveAmbientOwnerAgentId } from "../../../agents/agent-scope-config.js";
import { resolveCliRuntimeExecutionProvider } from "../../../agents/model-runtime-aliases.js";
import { isCliProvider } from "../../../agents/model-selection-cli.js";
import { resolveDefaultModelForAgent } from "../../../agents/model-selection-config.js";
import { resolveModelRefFromString } from "../../../agents/model-selection-shared.js";
import { isConfiguredCommandOwner } from "../../../auto-reply/command-auth.js";
import { resolveAgentMainSessionKey } from "../../../config/sessions/main-session.js";
import { resolveSessionStorePathCore } from "../../../config/sessions/paths.js";
import { readSessionEntryReadOnlyInWorker } from "../../../config/sessions/session-entry-read-runtime.js";
import type { SessionEntry } from "../../../config/sessions/types.js";
import type { OpenClawConfig } from "../../../config/types.openclaw.js";
import { tryResolveCronJobEffectiveAgentId } from "../../../cron/agent-id.js";
import {
  assembleScheduledAdmissionFacts,
  parentRowFactsFromEntry,
  scheduledParentLinkOf,
} from "../../../cron/execution-context-admission.js";
import {
  buildScheduledExecutionContext,
  resolveScheduledRequester,
  type ScheduledRequesterRef,
} from "../../../cron/execution-context.js";
import { resolveCronSessionTargetSessionKey } from "../../../cron/session-target.js";
import { rowToCronJob } from "../../../cron/store/row-codec.js";
import { resolveCronRunToolsAllow } from "../../../cron/tools-allow.js";
import type { CronStoredJob } from "../../../cron/types.js";
import { resolveOperatorRolePolicyForAssignment } from "../../../gateway/operator-role-policy.js";
import { formatErrorMessage } from "../../../infra/errors.js";
import { executeExistingOpenClawStateRead } from "../../../state/openclaw-state-db-readonly.js";
import {
  classifyScheduledJob,
  emptyScheduledContextReport,
  formatScheduledContextReport,
  type ScheduledContextReport,
  type ScheduledOwnerCheck,
} from "./execution-context-report.js";
import { inspectCronJobsForDoctor } from "./store-repair.js";

type OwnerResult = { owner: boolean | undefined; check: ScheduledOwnerCheck };

type CreatorProfile =
  | { assignedRole: string | null; githubLogin: string | null }
  | "missing"
  | "unreadable";

/** One stored user profile's role facts, read from state without the resident catalog. */
async function readCreatorProfile(
  env: NodeJS.ProcessEnv,
  profileId: string,
): Promise<CreatorProfile> {
  try {
    // A merged profile's row names its canonical profile, whose role and login apply.
    let row = await readProfileRow(env, profileId);
    if (row?.merged_into) {
      row = await readProfileRow(env, row.merged_into);
    }
    return row
      ? { assignedRole: row.role ?? null, githubLogin: row.githubLogin ?? null }
      : "missing";
  } catch {
    // An older or damaged profile store cannot answer; the review says so instead of failing.
    return "unreadable";
  }
}

// One stored profile row (role, merge target, GitHub login) through the state-read worker.
async function readProfileRow(env: NodeJS.ProcessEnv, profileId: string) {
  const reply = await executeExistingOpenClawStateRead(
    { env },
    { type: "userProfiles.reconcile", profileId },
  );
  return reply?.profile;
}

// Admission's creator-role sandbox rule, evaluated on the profile read above.
function creatorRoleSandbox(
  cfg: OpenClawConfig,
  job: CronStoredJob,
  profile: CreatorProfile | undefined,
): "required" | "none" {
  const actor = job.createdActor;
  if (actor?.type !== "human" || !actor.id) {
    return "none";
  }
  const facts = typeof profile === "object" ? profile : undefined;
  const policy = resolveOperatorRolePolicyForAssignment(
    actor.id,
    facts?.assignedRole ?? null,
    cfg,
    facts?.githubLogin ?? null,
  );
  return policy?.sandbox === "required" ? "required" : "none";
}

/**
 * The requester's current owner status, read without the Gateway. Profile and
 * configured channel owners can be read from state and config; linked channel
 * operators and operator snapshots need the running Gateway, so they are
 * reported as unverified and treated as non-owners.
 */
function checkRequesterOwnerReadOnly(
  cfg: OpenClawConfig,
  requester: ScheduledRequesterRef,
  profile: CreatorProfile | undefined,
): OwnerResult {
  switch (requester.kind) {
    case "unknown":
      return { owner: false, check: "checked" };
    case "profile":
      if (profile === "unreadable") {
        return { owner: false, check: "unverified" };
      }
      // Admission's rule: a current profile on an untiered install, or the Gateway owner profile.
      return {
        owner:
          typeof profile === "object" &&
          (!cfg.gateway?.roles || requester.profileId === GATEWAY_OWNER_PROFILE_ID),
        check: "checked",
      };
    case "channel": {
      const { channel, accountId, senderId } = requester.requester;
      if (isConfiguredCommandOwner(cfg, { channel, accountId, senderId })) {
        return { owner: true, check: "checked" };
      }
      // Without roles or identity scopes no linked channel operator can be an owner.
      const linkable = Boolean(cfg.gateway?.roles || cfg.gateway?.auth?.identityScopes);
      return { owner: false, check: linkable ? "unverified" : "checked" };
    }
    case "operator-source":
      return { owner: false, check: "unverified" };
  }
  return { owner: false, check: "unverified" };
}

// The CLI backend an agent turn's model resolves to by config, or undefined for embedded runs.
function resolveCliBackend(cfg: OpenClawConfig, agentId: string, job: CronStoredJob) {
  if (job.payload.kind !== "agentTurn") {
    return undefined;
  }
  const selection = {
    cfg,
    agentId,
    allowManifestNormalization: false,
    allowPluginNormalization: false,
  };
  const fallback = resolveDefaultModelForAgent(selection);
  const ref = job.payload.model
    ? resolveModelRefFromString({
        ...selection,
        raw: job.payload.model,
        defaultProvider: fallback.provider,
      })?.ref
    : fallback;
  if (!ref) {
    return undefined;
  }
  if (isCliProvider(ref.provider, cfg)) {
    return ref.provider;
  }
  return resolveCliRuntimeExecutionProvider({
    cfg,
    agentId,
    provider: ref.provider,
    modelId: ref.model,
  });
}

async function readParentEntry(cfg: OpenClawConfig, agentId: string, sessionKey: string) {
  return readSessionEntryReadOnlyInWorker({
    agentId,
    sessionKey,
    storePath: resolveSessionStorePathCore(cfg.session?.store, { agentId }),
    readConsistency: "latest",
  });
}

const exists = (path: string) =>
  access(path).then(
    () => true,
    () => false,
  );

/**
 * Builds one job's context the way occurrence admission does, from read-only
 * inputs, and adds its findings to the report.
 */
async function reviewJob(
  report: ScheduledContextReport,
  cfg: OpenClawConfig,
  env: NodeJS.ProcessEnv,
  job: CronStoredJob,
): Promise<void> {
  const agentId = tryResolveCronJobEffectiveAgentId(job, tryResolveAmbientOwnerAgentId(cfg));
  if (!agentId) {
    return;
  }
  // The creator's profile decides both the role sandbox and a profile requester's owner check.
  const actor = job.createdActor;
  const profile =
    actor?.type === "human" && actor.id ? await readCreatorProfile(env, actor.id) : undefined;
  // Read the parent row and requester only for a job linked to an exact incarnation.
  const parentKey = scheduledParentLinkOf(job)?.sessionKey;
  let entry: SessionEntry | undefined;
  let parentRow;
  let owner: OwnerResult = { owner: undefined, check: "not-needed" };
  if (parentKey) {
    entry = await readParentEntry(cfg, agentId, parentKey);
    const worktreePath = entry?.worktree ? entry.spawnedCwd : undefined;
    parentRow = parentRowFactsFromEntry(entry, worktreePath ? await exists(worktreePath) : false);
    owner = checkRequesterOwnerReadOnly(cfg, resolveScheduledRequester(job), profile);
  }
  const runSessionKey =
    job.sessionTarget === "main"
      ? resolveAgentMainSessionKey({ cfg, agentId })
      : (resolveCronSessionTargetSessionKey(job.sessionTarget) ??
        `agent:${agentId}:cron:${job.id}:run:doctor`);
  const facts = assembleScheduledAdmissionFacts(
    {
      cfg,
      job,
      trigger: "cron",
      runId: "doctor",
      agentId,
      runSessionKey,
      toolsAllow: resolveCronRunToolsAllow(job),
      creatorRoleSandbox: creatorRoleSandbox(cfg, job, profile),
    },
    parentRow,
    owner.owner,
  );
  classifyScheduledJob(report, {
    job,
    facts,
    result: buildScheduledExecutionContext(job, facts),
    ownerCheck: owner.check,
    ...(entry?.sessionId
      ? { parentChat: { chatType: entry.chatType, spawned: entry.spawnedBy !== undefined } }
      : {}),
    ...withCliBackend(resolveCliBackend(cfg, agentId, job)),
  });
}

function withCliBackend(cliBackend: string | undefined) {
  return cliBackend ? { cliBackend } : {};
}

/** Reviews every valid stored automation; a job that cannot be read is listed, not fatal. */
async function collectScheduledContextReport(params: {
  cfg: OpenClawConfig;
  env?: NodeJS.ProcessEnv;
}): Promise<ScheduledContextReport> {
  const env = params.env ?? process.env;
  const report = emptyScheduledContextReport();
  const inventory = await inspectCronJobsForDoctor({ env });
  for (const row of inventory.jobs) {
    // Decode with the runtime's own row codec; malformed rows are reported by the cron store check.
    const job =
      row.invalidReason || !row.definition
        ? null
        : rowToCronJob(
            { job_id: row.id, state_json: "{}", runtime_updated_at_ms: null, updated_at: 0 },
            row.definition,
          );
    if (!job) {
      continue;
    }
    try {
      await reviewJob(report, params.cfg, env, job);
    } catch (error) {
      report.failed.push({
        job: { id: job.id, name: job.name?.trim() || job.id, enabled: job.enabled },
        reason: formatErrorMessage(error),
      });
    }
  }
  return report;
}

/** Notes the review under Cron when any automation changes. */
export async function noteScheduledContextReport(params: {
  cfg: OpenClawConfig;
  env?: NodeJS.ProcessEnv;
}): Promise<void> {
  let text: string | null;
  try {
    text = formatScheduledContextReport(await collectScheduledContextReport(params));
  } catch (error) {
    // An advisory review never stops the rest of Doctor.
    text = `Scheduled-run access review could not read stored automations: ${formatErrorMessage(error)}`;
  }
  if (text) {
    note(text, "Cron");
  }
}
