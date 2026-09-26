import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { resolveCronSessionTargetSessionKey } from "../../cron/session-target.js";
import type { CronJob } from "../../cron/types.js";
import { getCronManagementAuthority } from "../cron-creator-authority-grant.js";
import type { PreparedSessionMutationFacts } from "../session-sharing-policy.js";
import {
  prepareSessionMutationFacts,
  type SessionFactsRead,
} from "../session-sharing-preparation.js";
import { prepareProjectedSessionSharing } from "../session-sharing.js";
import { resolveSessionStoreIdentity } from "../session-store-key.js";
import type { GatewayClient } from "./types.js";

type CronSessionVisibility = (sessionKey: string, agentId?: string) => boolean;

function resolveCronEntryFilter(client: GatewayClient | null, cfg: OpenClawConfig) {
  const identity = client?.internal?.agentRuntimeIdentity;
  if (identity && getCronManagementAuthority(identity)) {
    return undefined;
  }
  const sharing = prepareProjectedSessionSharing({ client, cfg, isMember: () => false });
  return sharing.sessionCap === "none" ? sharing.entryFilter : undefined;
}

type CronVisibilityTarget = { sessionKey: string; agentId?: string };

/** Request custody belongs to the existing exact sharing reader, including after awaits. */
export function createCronSessionVisibility(
  client: GatewayClient | null,
  getConfig: () => OpenClawConfig,
) {
  const reads = new Map<string, SessionFactsRead<PreparedSessionMutationFacts>>();
  const keyFor = (target: CronVisibilityTarget, cfg: OpenClawConfig) => {
    const identity = resolveSessionStoreIdentity({ ...target, cfg });
    return { ...identity, key: `${identity.agentId}\0${identity.canonicalKey}` };
  };
  return {
    prepare(targets: readonly (CronVisibilityTarget | undefined)[]): Promise<void> | undefined {
      const cfg = getConfig();
      if (
        !resolveCronEntryFilter(client, cfg) ||
        !targets.some((target) => target && !reads.has(keyFor(target, cfg).key))
      ) {
        return undefined;
      }
      // Only new facts yield; ready consumers can select and publish in one frame.
      return (async () => {
        for (const target of targets) {
          if (!target) {
            continue;
          }
          const { key, agentId } = keyFor(target, cfg);
          if (!reads.has(key)) {
            reads.set(
              key,
              await prepareSessionMutationFacts({
                cfg,
                sessionKey: target.sessionKey,
                agentId,
                allowMissing: true,
              }),
            );
          }
        }
      })();
    },
    resolve(): CronSessionVisibility | undefined {
      if (!resolveCronEntryFilter(client, getConfig())) {
        return undefined;
      }
      return (sessionKey, agentId) => {
        const cfg = getConfig();
        const filter = resolveCronEntryFilter(client, cfg);
        if (!filter) {
          return true;
        }
        const { key } = keyFor({ sessionKey, agentId }, cfg);
        const target = reads.get(key)?.readCurrent(cfg).target;
        return Boolean(target && filter(target.canonicalKey, target.entry));
      };
    },
    release() {
      for (const read of reads.values()) {
        read.release();
      }
      reads.clear();
    },
  };
}

export function cronJobVisibilityTarget(job: CronJob | undefined, defaultAgentId?: string) {
  if (!job) {
    return undefined;
  }
  const sessionKey =
    job.owner?.sessionKey ??
    resolveCronSessionTargetSessionKey(job.sessionTarget) ??
    job.sessionKey;
  return sessionKey
    ? { sessionKey, agentId: job.owner?.agentId ?? job.agentId ?? defaultAgentId }
    : undefined;
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
