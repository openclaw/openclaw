import { isDeepStrictEqual } from "node:util";
import { resolveAgentMainSessionKey } from "../../config/sessions/main-session.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { resolveCronJobEffectiveAgentId } from "../../cron/agent-id.js";
import { resolveCronSessionTargetSessionKey } from "../../cron/session-target.js";
import type { CronJob, CronJobPatch } from "../../cron/types.js";
import { operatorScopeSatisfied } from "../../shared/operator-scope-compat.js";
import { prepareUserProfileSelectionAuthority } from "../../state/user-channel-identity-operations.js";
import { readResidentUserProfileId } from "../../state/user-profile-list.js";
import { authorizeGatewaySessionCreation } from "../operator-role-policy.js";
import { authorizePreparedSessionMutation } from "../session-sharing-policy.js";
import { prepareSessionMutationFacts } from "../session-sharing-preparation.js";
import {
  prepareProjectedSessionSharing,
  prepareSessionSharingProfiles,
} from "../session-sharing-read.js";
import type { GatewayClient } from "./types.js";

/** Direct human management never substitutes for an agent turn's narrower capability. */
export function isHumanCronMutation(method: string): boolean {
  return (
    method === "cron.update" ||
    method === "cron.remove" ||
    method === "cron.run" ||
    method === "cron.scratch.set"
  );
}

export function isDirectCronOwnerClient(client: GatewayClient | null | undefined): boolean {
  return (
    !client?.internal?.agentRuntimeIdentity &&
    Boolean(client?.authenticatedUserProfile) &&
    operatorScopeSatisfied("operator.cron", client?.connect?.scopes ?? [])
  );
}

export function isHumanCronJobOwner(
  client: GatewayClient | null | undefined,
  job: CronJob,
): boolean {
  if (client?.internal?.agentRuntimeIdentity || !job.ownerProfileId) {
    return false;
  }
  const profileId = client?.authenticatedUserProfile?.profileId;
  const ownerId = readResidentUserProfileId(job.ownerProfileId);
  return Boolean(ownerId && profileId && ownerId === readResidentUserProfileId(profileId));
}

export function canHumanManageCronJob(
  client: GatewayClient | null | undefined,
  job: CronJob,
): boolean {
  if (
    !client?.connect ||
    client.internal?.agentRuntimeIdentity ||
    client.connect.scopes?.includes("operator.admin")
  ) {
    return true;
  }
  return isDirectCronOwnerClient(client) && isHumanCronJobOwner(client, job);
}

export function assertHumanCronJobAccess(
  client: GatewayClient | null | undefined,
  job: CronJob,
): void {
  if (!canHumanManageCronJob(client, job)) {
    throw new TypeError(
      "Only the automation's human owner or an administrator can change or run it.",
    );
  }
}

/** Validate the selected profile at the identity owner, retaining its commit-time check. */
export async function prepareCronOwnerChange(
  client: GatewayClient | null | undefined,
  job: CronJob,
  patch: CronJobPatch,
): Promise<(() => void) | undefined> {
  if (patch.ownerProfileId === undefined) {
    return undefined;
  }
  if (client?.internal?.agentRuntimeIdentity) {
    throw new TypeError("Change the human owner from the Automations page.");
  }
  assertHumanCronJobAccess(client, job);
  const selection = await prepareUserProfileSelectionAuthority(patch.ownerProfileId);
  if (!selection) {
    throw new TypeError("Select an existing human owner.");
  }
  patch.ownerProfileId = selection.profileId;
  return () => {
    if (!selection.isCurrent()) {
      throw new TypeError("The selected human owner changed. Select the owner again.");
    }
  };
}

/** Owning a schedule does not grant host command execution or arbitrary session routing. */
export function assertHumanCronExecutionAccess(
  client: GatewayClient | null | undefined,
  job: CronJob,
  patch?: CronJobPatch,
): void {
  if (!isDirectCronOwnerClient(client) || client?.connect?.scopes?.includes("operator.admin")) {
    return;
  }
  if (operatorScopeSatisfied("operator.write", client?.connect?.scopes ?? [])) {
    return;
  }
  const hostCommand =
    job.payload.kind === "command" ||
    job.schedule.kind === "on-exit" ||
    job.schedule.kind === "stream" ||
    patch?.payload?.kind === "command" ||
    patch?.schedule?.kind === "on-exit" ||
    patch?.schedule?.kind === "stream";
  // Pause, delete, and transfer remain available without authorizing another host process.
  const currentFields = new Map(Object.entries(job));
  const passivePatch =
    patch &&
    Object.entries(patch).every(
      ([key, value]) =>
        isDeepStrictEqual(value, currentFields.get(key)) ||
        key === "name" ||
        key === "ownerProfileId" ||
        key === "displayName" ||
        key === "description" ||
        (key === "enabled" && patch.enabled === false),
    );
  if (hostCommand && !passivePatch) {
    throw new TypeError(
      "Running or changing host-command automations requires operator.write. You can still pause, transfer, or delete your automation.",
    );
  }
}

/** Retargeting uses the same agent ceiling and session access as an interactive run. */
export async function prepareHumanCronTargetAccess(
  client: GatewayClient | null,
  getConfig: () => OpenClawConfig,
  previous: CronJob,
  next: CronJob,
  defaultAgentId?: string,
): Promise<{ assertCurrent: () => void; release: () => void } | undefined> {
  if (!isDirectCronOwnerClient(client) || client?.connect?.scopes?.includes("operator.admin")) {
    return undefined;
  }
  if (
    previous.agentId === next.agentId &&
    previous.sessionKey === next.sessionKey &&
    previous.sessionTarget === next.sessionTarget
  ) {
    return undefined;
  }
  const cfg = getConfig();
  const agentId = resolveCronJobEffectiveAgentId(next, defaultAgentId);
  const sessionKey =
    next.sessionTarget === "main"
      ? resolveAgentMainSessionKey({ cfg, agentId })
      : (resolveCronSessionTargetSessionKey(next.sessionTarget) ?? next.sessionKey);
  const profiles = await prepareSessionSharingProfiles(client);
  const facts = sessionKey
    ? await prepareSessionMutationFacts({ cfg, agentId, sessionKey, allowMissing: true })
    : undefined;
  const assertCurrent = () => {
    const currentConfig = getConfig();
    const agentError = authorizeGatewaySessionCreation({ cfg: currentConfig, client, agentId });
    if (agentError) {
      throw new TypeError(agentError.message);
    }
    if (!facts || !sessionKey) {
      return;
    }
    const current = facts.readCurrent(currentConfig);
    const projected = prepareProjectedSessionSharing({
      cfg: currentConfig,
      client,
      profiles,
      isMember: (_target, identityId) => current.membership.has(identityId),
    });
    const error = authorizePreparedSessionMutation(
      { cfg: currentConfig, client, agentId, sessionKey },
      current,
      { policy: projected.policy, aliases: profiles.readCurrent().profile?.aliases ?? new Set() },
    );
    if (error) {
      throw new TypeError(error.message);
    }
  };
  try {
    assertCurrent();
    return { assertCurrent, release: () => facts?.release() };
  } catch (error) {
    facts?.release();
    throw error;
  }
}
