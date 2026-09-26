import { expectDefined } from "@openclaw/normalization-core";
import { resolveAgentDir } from "../agents/agent-scope-config.js";
import { findPersistedAuthProfileCredential } from "../agents/auth-profiles/store.js";
import { clearRemovedQueuedAuthProfiles } from "../auto-reply/reply/queue.js";
import { patchSessionEntryTarget } from "../config/sessions/session-accessor.js";
import { prepareSessionStoreTargetInventory } from "../config/sessions/session-store-target-inventory.js";
import { withSessionHistoryWorkerReadCandidates } from "../config/sessions/session-transcript-worker-resources.js";
import { withSessionHistoryWorkerDatabase } from "../config/sessions/session-transcript-worker-runtime.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { normalizeAgentId, parseAgentSessionKey } from "../routing/session-key.js";
import { prepareOpenClawAgentDatabaseRegistrySnapshotRead } from "../state/openclaw-agent-db-registry-listing.js";

/** Release only references to credentials whose owning store confirmed removal. */
export async function clearRemovedSessionAuthProfiles(params: {
  cfg: OpenClawConfig;
  removedByAgent: ReadonlyMap<string, ReadonlySet<string>>;
  rewriteConfig: (cfg: OpenClawConfig) => OpenClawConfig;
}): Promise<void> {
  clearRemovedQueuedAuthProfiles(params);
  if (params.removedByAgent.size === 0) {
    return;
  }
  const { candidates, ...inventory } = prepareSessionStoreTargetInventory(params.cfg, [
    ...params.removedByAgent.keys(),
  ]);
  const registry = prepareOpenClawAgentDatabaseRegistrySnapshotRead({ env: inventory.env });
  await withSessionHistoryWorkerReadCandidates(candidates, async (discovery) => {
    let sources = await discovery.readTargetInventory({
      ...inventory,
      registeredDatabases: { status: "deferred" },
    });
    if (sources.kind === "session-target-registry-required") {
      const current = await registry.read();
      sources = await discovery.readTargetInventory({
        ...inventory,
        registeredDatabases:
          current.result.status === "available"
            ? current.result.entries
            : { status: "unavailable" },
      });
    }
    if (sources.kind !== "session-target-inventory") {
      throw new Error("Session stores could not be resolved after removing the account.");
    }
    for (const { agentId, result, reads } of sources.agents) {
      if (!result.available) {
        if (result.reason === "database-missing") {
          continue;
        }
        throw new Error(
          `Sessions for agent ${agentId} could not be read after removing the account.`,
        );
      }
      const removed = expectDefined(params.removedByAgent.get(agentId), "removed agent profiles");
      const agentDir = resolveAgentDir(params.cfg, agentId);
      const isRemoved = (profileId: string | undefined): profileId is string =>
        profileId !== undefined && removed.has(profileId);
      for (const { database } of reads) {
        await withSessionHistoryWorkerDatabase(
          { ...database, env: inventory.env },
          async (owner) => {
            const assertCurrent = () => {
              discovery.assertCurrent();
              registry.assertCurrent();
              owner.assertCurrent();
            };
            const entries = await owner.readEntries({
              agentId: database.agentId,
              storePath: database.path,
              env: inventory.env,
              projection: "list",
              readConsistency: "latest",
            });
            // A physical store can hold several agents. Unscoped sentinel rows belong
            // to the physical owner; qualified rows retain their logical agent.
            const sessionKeys = entries
              .filter(
                ({ sessionKey, entry }) =>
                  normalizeAgentId(
                    parseAgentSessionKey(sessionKey)?.agentId ?? database.agentId,
                  ) === agentId &&
                  (isRemoved(entry.authProfileOverride) ||
                    isRemoved(entry.modelFallback?.prevAuthProfileOverride)),
              )
              .map(({ sessionKey }) => sessionKey);
            if (sessionKeys.length === 0) {
              return;
            }
            const selected = await owner.readExactEntries({
              env: inventory.env,
              sessionKeys,
              includeAuthorization: true,
            });
            assertCurrent();
            if (selected.entries.length === 0) {
              return;
            }
            const identity = expectDefined(selected.databaseIdentity, "session database identity");
            for (const { sessionKey, entry } of selected.entries) {
              const profileIds = new Set(
                [entry.authProfileOverride, entry.modelFallback?.prevAuthProfileOverride].filter(
                  isRemoved,
                ),
              );
              // Retire each account independently so reconnecting one cannot retain
              // another deleted account in fallback state.
              for (const profileId of profileIds) {
                await patchSessionEntryTarget(
                  {
                    agentId,
                    storePath: database.path,
                    env: inventory.env,
                    readSource: {
                      ...database,
                      databaseIdentity: identity.identity,
                      databaseBirthtime: identity.birthtime,
                    },
                    target: { canonicalKey: sessionKey, storeKeys: [sessionKey] },
                  },
                  (current) => {
                    const clearCurrent = current.authProfileOverride === profileId;
                    const fallback = current.modelFallback;
                    const clearPrevious = fallback?.prevAuthProfileOverride === profileId;
                    if (!clearCurrent && !clearPrevious) {
                      return null;
                    }
                    return {
                      ...(clearCurrent
                        ? {
                            authProfileOverride: undefined,
                            authProfileOverrideSource: undefined,
                            authProfileOverrideCompactionCount: undefined,
                          }
                        : {}),
                      // Keep model rollback while preventing it from restoring a deleted account.
                      ...(clearPrevious
                        ? {
                            modelFallback: {
                              ...fallback,
                              prevAuthProfileOverride: undefined,
                              prevAuthProfileOverrideSource: undefined,
                              prevAuthProfileOverrideCompactionCount: undefined,
                            },
                          }
                        : {}),
                    };
                  },
                  {
                    preserveActivity: true,
                    skipMaintenance: true,
                    // Reconnect can reuse an ID while discovery/patch preparation awaits.
                    // Do not clear the new credential's selection at the final commit.
                    shouldCommit: () =>
                      !findPersistedAuthProfileCredential({ agentDir, profileId }),
                    assertCommitAllowed: assertCurrent,
                  },
                );
              }
            }
          },
        );
      }
    }
  });
}
