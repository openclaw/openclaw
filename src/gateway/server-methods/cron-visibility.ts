import { listAgentIds } from "../../agents/agent-scope-config.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { tryResolveCronJobEffectiveAgentId } from "../../cron/agent-id.js";
import { resolveCronSessionTargetSessionKey } from "../../cron/session-target.js";
import type { CronJob } from "../../cron/types.js";
import { isIncognitoSessionKey, parseAgentSessionKey } from "../../routing/session-key.js";
import { getCronManagementAuthority } from "../cron-creator-authority-grant.js";
import { requireSessionRowProjection } from "../session-row-projection-access.js";
import { prepareProjectedSessionSharing } from "../session-sharing.js";
import { resolveSessionStoreIdentity } from "../session-store-key.js";
import { resolveCronJobOwnerAgentId } from "./cron-caller-scope.js";
import type { GatewayClient, GatewayRequestContext } from "./types.js";

type CronSessionVisibility = (sessionKey: string, agentId?: string) => boolean;

function resolveCronEntryFilter(client: GatewayClient | null, cfg: OpenClawConfig) {
  const identity = client?.internal?.agentRuntimeIdentity;
  if (identity && getCronManagementAuthority(identity)) {
    return undefined;
  }
  const sharing = prepareProjectedSessionSharing({ client, cfg, isMember: () => false });
  return sharing.sessionCap === "none" || sharing.sessionCap === "invited"
    ? sharing.entryFilter
    : undefined;
}

/** The Gateway projection owns sharing facts and consumes committed write receipts. */
export function createCronSessionVisibility(
  client: GatewayClient | null,
  context: Pick<GatewayRequestContext, "getRuntimeConfig" | "sessionRowProjectionOwner">,
) {
  return {
    async prepare(): Promise<void> {
      if (!resolveCronEntryFilter(client, context.getRuntimeConfig())) {
        return undefined;
      }
      const projection = requireSessionRowProjection(context);
      await projection.prepareSelection({ metadataOnly: true });
      await projection.prepareMembership();
    },
    resolve(): CronSessionVisibility | undefined {
      if (!resolveCronEntryFilter(client, context.getRuntimeConfig())) {
        return undefined;
      }
      return (sessionKey, agentId) => {
        const cfg = context.getRuntimeConfig();
        const filter = resolveCronEntryFilter(client, cfg);
        if (!filter) {
          return true;
        }
        const identity = resolveSessionStoreIdentity({ sessionKey, agentId, cfg });
        const projection = requireSessionRowProjection(context);
        let query = {
          agentId: identity.agentId,
          key: identity.canonicalKey,
        };
        const parsed = parseAgentSessionKey(sessionKey);
        if (
          parsed?.agentId === "main" &&
          !isIncognitoSessionKey(sessionKey) &&
          !listAgentIds(cfg).includes(parsed.agentId)
        ) {
          const retained = {
            agentId: parsed.agentId,
            key: `agent:${parsed.agentId}:${parsed.rest}`,
          };
          // Retained deleted-main rows win over replacement aliases, even while sharing is pending.
          if (projection.capture(retained)) {
            query = retained;
          }
        }
        const target = projection.sharingTarget(query);
        const sharing = prepareProjectedSessionSharing({
          client,
          cfg,
          isMember: (candidate, id) =>
            projection.hasMembership(candidate.storePath, candidate.storeKey, id),
        });
        return Boolean(target && sharing.canReadTarget(target));
      };
    },
  };
}

function cronJobVisibilityTarget(job: CronJob | undefined, defaultAgentId?: string) {
  if (!job) {
    return undefined;
  }
  const sessionKey =
    job.owner?.sessionKey ??
    resolveCronSessionTargetSessionKey(job.sessionTarget) ??
    job.sessionKey;
  if (!sessionKey) {
    return undefined;
  }
  const agentId =
    resolveCronJobOwnerAgentId(job) ?? tryResolveCronJobEffectiveAgentId(job, defaultAgentId);
  return agentId ? { sessionKey, agentId } : undefined;
}

export function cronJobIsVisible(
  job: CronJob,
  visibility: CronSessionVisibility | undefined,
  defaultAgentId: string | undefined,
): boolean {
  if (!visibility) {
    return true;
  }
  const target = cronJobVisibilityTarget(job, defaultAgentId);
  return Boolean(target && visibility(target.sessionKey, target.agentId));
}
