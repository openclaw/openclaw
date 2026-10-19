import {
  createRuntimeConfigReader,
  getRuntimeConfigSnapshot,
  getRuntimeConfigSnapshotMetadata,
} from "../config/runtime-snapshot.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  resolveCreatorSandbox,
  resolveOperatorRolePolicyForAssignment,
} from "../gateway/operator-role-policy.js";
import {
  prepareUserChannelIdentityAuthority,
  prepareUserProfileRoleAuthority,
} from "../state/user-channel-identity-operations.js";
import {
  resolveCronAuthenticatedCallerOrigin,
  resolveCronAuthenticatedChannelRequester,
} from "./tools-allow-provenance.js";
import type { CronStoredJob } from "./types.js";

/** Historical actors are attribution; only the authenticated requester binds channel authority. */
export async function resolveCronCreatorSandbox(cfg: OpenClawConfig, job: CronStoredJob) {
  const readConfig = createRuntimeConfigReader(cfg);
  const followsRuntime = readConfig() === getRuntimeConfigSnapshot();
  const publication = getRuntimeConfigSnapshotMetadata();
  const roles = cfg.gateway?.roles;
  const origin = resolveCronAuthenticatedCallerOrigin(job);
  const requester = resolveCronAuthenticatedChannelRequester(job);
  // Local provenance supersedes a reused session's channel attribution.
  const actor =
    origin?.kind === "local" &&
    job.createdActor?.type === "human" &&
    job.createdActor.source === "channel"
      ? undefined
      : job.createdActor;
  const channelCreated =
    (actor?.type === "human" && actor.source === "channel") ||
    origin?.kind === "external" ||
    Boolean(job.toolsAllowProvenance?.channelRequester);
  const reauthorizationError = () =>
    new Error(
      "Automation channel requester is unbound or no longer authorized. Ask a Gateway administrator to use cron.reauthorizeChannelRequester with the exact channel, account, sender, canonical profile and current config revision.",
    );
  if (channelCreated && !requester) {
    throw reauthorizationError();
  }
  if (requester && origin && (origin.kind !== "external" || origin.channel !== requester.channel)) {
    throw reauthorizationError();
  }
  const linked = requester
    ? await prepareUserChannelIdentityAuthority({
        channelId: requester.channel,
        accountId: requester.accountId,
        senderId: requester.senderId,
      })
    : undefined;
  if (requester && !linked) {
    throw reauthorizationError();
  }
  const profileId =
    linked?.linked.profileId ??
    (actor?.type === "human" && actor.source === "profile" ? actor.id : undefined);
  const profileAuthority =
    roles && profileId && !linked ? await prepareUserProfileRoleAuthority(profileId) : undefined;
  const profile = linked?.linked ?? profileAuthority;
  const assertCurrent = () => {
    if (
      (followsRuntime && getRuntimeConfigSnapshotMetadata() !== publication) ||
      readConfig().gateway?.roles !== roles ||
      (linked && !linked.isCurrent()) ||
      (roles && profileId && !linked && (!profileAuthority || !profileAuthority.isCurrent()))
    ) {
      throw channelCreated
        ? reauthorizationError()
        : new Error(
            "Automation creator profile authority changed during preparation. Retry the run to recompute the current sandbox policy; if the profile was removed, ask an administrator to restore its authority.",
          );
    }
  };
  assertCurrent();
  const sandbox = profile
    ? resolveOperatorRolePolicyForAssignment(
        profile.profileId,
        profile.role,
        cfg,
        profile.githubLogin ?? null,
      )?.sandbox
    : resolveCreatorSandbox(cfg, { actor: requester ? undefined : actor });
  return {
    sandbox: sandbox === "required" ? ("required" as const) : undefined,
    profileId: profile?.profileId ?? profileId,
    assertCurrent,
  };
}
