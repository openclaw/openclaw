import { expectDefined } from "@openclaw/normalization-core";
import { listAgentIds } from "../agents/agent-scope.js";
import { resolveAgentMainSessionKey } from "../config/sessions/main-session.js";
import type { SessionStoreReadCandidate } from "../config/sessions/session-store-read-candidates.js";
import { prepareSessionStoreTargetInventory } from "../config/sessions/session-store-target-inventory.js";
import { withSessionHistoryWorkerReadCandidates } from "../config/sessions/session-transcript-worker-resources.js";
import { withSessionHistoryWorkerDatabases } from "../config/sessions/session-transcript-worker-runtime.js";
import type { SessionEntry } from "../config/sessions/types.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  DEFAULT_AGENT_ID,
  isIncognitoSessionKey,
  normalizeAgentId,
  parseAgentSessionKey,
} from "../routing/session-key.js";
import { prepareOpenClawAgentDatabaseRegistrySnapshotRead } from "../state/openclaw-agent-db-registry-listing.js";
import { registerOpenClawAgentDatabaseReadCandidateResource } from "../state/openclaw-agent-db-resources.js";
import { MAX_MENTION_POLICY_TARGETS } from "./human-mention-policy-read.types.js";
import { resolveRequestedSessionAgentId } from "./session-request-agent.js";
import type { SessionSharingTarget } from "./session-sharing-policy.js";
import {
  resolveSessionStoreIdentity,
  resolveStoredSessionKeyForAgentStore,
} from "./session-store-key.js";
import { resolveGatewaySessionStoreReadResults } from "./session-utils-store-selection.js";

export type PreparedHumanMentionTarget = SessionSharingTarget & {
  database: { agentId: string; path: string };
};

export type HumanMentionTargetInput = { sessionKey: string; agentId?: string };

export type HumanMentionTargetAuthority = { assertCurrent: () => void; dispose: () => void };

/** Cached facts retain close custody independently of the native readers' shorter lifetime. */
function retainTargetAuthority(
  candidates: readonly SessionStoreReadCandidate[],
): HumanMentionTargetAuthority {
  let active = true;
  const releases: Array<() => void> = [];
  const dispose = () => {
    active = false;
    for (const release of releases.splice(0)) {
      release();
    }
  };
  const retained = new Set<string>();
  try {
    for (const candidate of candidates) {
      for (const path of [candidate.path, candidate.physicalPath]) {
        const key = JSON.stringify([path, candidate.scope]);
        if (retained.has(key)) {
          continue;
        }
        retained.add(key);
        releases.push(
          registerOpenClawAgentDatabaseReadCandidateResource({
            path,
            scope: candidate.scope,
            revoke: dispose,
            close: async () => dispose(),
          }),
        );
      }
    }
  } catch (error) {
    dispose();
    throw error;
  }
  return {
    assertCurrent() {
      if (!active) {
        throw new Error("Mention target authority was revoked");
      }
    },
    dispose,
  };
}

type Lookup = { agentId: string; canonicalKey: string; keys: string[] };

function normalLookup(cfg: OpenClawConfig, input: HumanMentionTargetInput): Lookup {
  const sessionKey = input.sessionKey.trim();
  const requested = resolveRequestedSessionAgentId(cfg, sessionKey, input.agentId);
  const identity = resolveSessionStoreIdentity({
    cfg,
    sessionKey,
    agentId: input.agentId ?? (requested.ok ? requested.agentId : undefined),
  });
  const keys = new Set([identity.canonicalKey, sessionKey]);
  if (identity.canonicalKey === resolveAgentMainSessionKey({ cfg, agentId: identity.agentId })) {
    keys.add("agent:" + identity.agentId + ":main");
  }
  return { ...identity, keys: [...keys] };
}

/** Exact keys only, using the existing discovery and canonical session reader lifetimes. */
export async function prepareHumanMentionTargets(
  cfg: OpenClawConfig,
  targets: readonly HumanMentionTargetInput[],
  captureAuthority?: (authority: HumanMentionTargetAuthority) => void,
): Promise<Array<PreparedHumanMentionTarget | null>> {
  if (targets.length > MAX_MENTION_POLICY_TARGETS) {
    throw new Error("Mention policy targets exceed their preparation budget");
  }
  const plans = targets.map((input) => {
    if (isIncognitoSessionKey(input.sessionKey)) {
      return undefined;
    }
    const sessionKey = input.sessionKey.trim();
    const parsed = parseAgentSessionKey(sessionKey);
    let legacy: Lookup | undefined;
    if (
      parsed &&
      normalizeAgentId(parsed.agentId) === DEFAULT_AGENT_ID &&
      !listAgentIds(cfg).includes(DEFAULT_AGENT_ID)
    ) {
      const canonicalKey = resolveStoredSessionKeyForAgentStore({
        cfg,
        agentId: DEFAULT_AGENT_ID,
        sessionKey,
      });
      legacy = {
        agentId: DEFAULT_AGENT_ID,
        canonicalKey,
        keys: [
          ...new Set([
            sessionKey,
            canonicalKey,
            resolveAgentMainSessionKey({ cfg, agentId: DEFAULT_AGENT_ID }),
            "agent:main:main",
          ]),
        ],
      };
    }
    let normal: Lookup | undefined;
    let error: unknown;
    try {
      normal = normalLookup(cfg, input);
    } catch (cause) {
      error = cause;
    }
    if (!normal && !legacy) {
      throw error;
    }
    return { normal, legacy, error };
  });
  const agentIds = plans.flatMap((plan) =>
    plan
      ? [
          ...(plan.normal ? [plan.normal.agentId] : []),
          ...(plan.legacy ? [plan.legacy.agentId] : []),
        ]
      : [],
  );
  if (!agentIds.length) {
    return targets.map(() => null);
  }
  const prepared = prepareSessionStoreTargetInventory(cfg, agentIds);
  const registryRead = prepareOpenClawAgentDatabaseRegistrySnapshotRead({ env: prepared.env });
  const retainedAuthority = captureAuthority
    ? retainTargetAuthority(prepared.candidates)
    : undefined;
  let handedOff = false;
  try {
    const resolvedTargets = await withSessionHistoryWorkerReadCandidates(
      prepared.candidates,
      async (discovery) => {
        let inventory = await discovery.readTargetInventory({
          ...prepared,
          registeredDatabases: { status: "deferred" },
        });
        let assertRegistryCurrent: (() => void) | undefined;
        if (inventory.kind === "session-target-registry-required") {
          const registry = await registryRead.read();
          assertRegistryCurrent = registry.assertCurrent;
          registry.assertCurrent();
          discovery.assertCurrent();
          inventory = await discovery.readTargetInventory({
            ...prepared,
            registeredDatabases:
              registry.result.status === "available"
                ? registry.result.entries
                : { status: "unavailable" },
          });
          if (inventory.kind === "session-target-registry-required") {
            throw new Error("Session discovery requested registry rows twice");
          }
        }
        assertRegistryCurrent?.();
        discovery.assertCurrent();
        const agents = new Map(inventory.agents.map((agent) => [agent.agentId, agent]));
        const groups = new Map<
          string,
          {
            database: { agentId: string; path: string };
            keys: Set<string>;
            store?: Record<string, SessionEntry>;
          }
        >();
        const groupKey = (database: { agentId: string; path: string }) => JSON.stringify(database);
        for (const plan of plans) {
          for (const lookup of plan
            ? [...(plan.normal ? [plan.normal] : []), ...(plan.legacy ? [plan.legacy] : [])]
            : []) {
            const observed = expectDefined(agents.get(lookup.agentId), "mention target inventory");
            if (!observed.result.available && observed.result.reason !== "database-missing") {
              throw new Error("Mention session metadata is unavailable");
            }
            for (const { database } of observed.reads) {
              const key = groupKey(database);
              const group = groups.get(key) ?? { database, keys: new Set<string>() };
              for (const sessionKey of lookup.keys) {
                group.keys.add(sessionKey);
              }
              groups.set(key, group);
            }
          }
        }
        const reads = [...groups.values()];
        return await withSessionHistoryWorkerDatabases(
          reads.map((read) => ({ ...read.database, env: prepared.env })),
          async (owners) => {
            for (const [index, group] of reads.entries()) {
              const owner = expectDefined(owners[index], "mention exact reader");
              const result = await owner.readExactEntries({
                sessionKeys: [...group.keys],
                env: prepared.env,
              });
              group.store = Object.fromEntries(
                result.entries.map(({ sessionKey, entry }) => [sessionKey, entry]),
              );
            }
            assertRegistryCurrent?.();
            discovery.assertCurrent();
            for (const owner of owners) {
              owner.assertCurrent();
            }
            if (captureAuthority && retainedAuthority) {
              captureAuthority({
                assertCurrent() {
                  retainedAuthority.assertCurrent();
                  assertRegistryCurrent?.();
                  for (const owner of owners) {
                    owner.assertCurrent();
                  }
                },
                dispose: retainedAuthority.dispose,
              });
            }
            const select = (lookup: Lookup): PreparedHumanMentionTarget | null => {
              const observed = expectDefined(
                agents.get(lookup.agentId),
                "mention target inventory",
              );
              const candidates = observed.reads.map(({ target, database }) => ({
                storePath: target.storePath,
                readSource: database,
                store: expectDefined(groups.get(groupKey(database))?.store, "mention exact rows"),
              }));
              if (!candidates.length) {
                return null;
              }
              const selected = resolveGatewaySessionStoreReadResults({
                reads: candidates,
                readStore: (read) => read.store,
                scanTargets: lookup.keys,
                canonicalKey: lookup.canonicalKey,
              });
              const match = selected.match;
              if (!match) {
                return null;
              }
              return {
                agentId: lookup.agentId,
                canonicalKey: lookup.canonicalKey,
                entry: match.entry,
                storeKey: match.key,
                storeKeys: [...new Set([lookup.canonicalKey, ...lookup.keys, match.key])],
                storePath: selected.storePath,
                database: expectDefined(selected.readSource, "mention physical target"),
              };
            };
            return plans.map((plan) => {
              if (!plan) {
                return null;
              }
              const legacy = plan.legacy && select(plan.legacy);
              if (legacy) {
                return legacy;
              }
              if (!plan.normal) {
                throw plan.error;
              }
              return select(plan.normal);
            });
          },
        );
      },
    );
    retainedAuthority?.assertCurrent();
    handedOff = true;
    return resolvedTargets;
  } finally {
    if (!handedOff) {
      retainedAuthority?.dispose();
    }
  }
}
