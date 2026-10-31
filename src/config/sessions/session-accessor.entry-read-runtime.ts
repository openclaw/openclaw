import { expectDefined } from "@openclaw/normalization-core/expect";
import { resolveSessionStoreIdentity } from "../../gateway/session-store-key.js";
import { cloneEnvWithPlatformSemantics } from "../config-env-vars.js";
import { collectCanonicalSessionLookupKeys } from "./main-session-key.js";
import { resolveSessionStorePathCore } from "./paths.js";
import { captureMemoryExactSessionReader } from "./session-accessor.memory-exact-read.js";
import type {
  LogicalSessionAccessScope,
  ResolvedSessionEntryAccessTarget,
  ResolvedSessionEntryStoreTarget,
  SessionEntrySummary,
} from "./session-accessor.types.js";
import { canonicalSessionKeyMigrationRequiredError } from "./session-canonical-key.js";
import { withSessionEntriesFromStoresInWorker } from "./session-entry-read-runtime.js";
import { prepareSessionStoreTargetInventory } from "./session-store-target-inventory.js";
import { prepareSessionStoreTargetInventoryRead } from "./session-store-target-runtime.js";
import { listConfiguredSessionStoreAgentIds, type SessionStoreTarget } from "./targets.js";
import type { InternalSessionEntry as SessionEntry } from "./types.js";

export function selectCanonicalSessionEntryMatch(
  entries: readonly SessionEntrySummary[],
  canonicalKey: string,
): SessionEntrySummary | undefined {
  let selected: SessionEntrySummary | undefined;
  for (const match of entries) {
    if (selected) {
      throw canonicalSessionKeyMigrationRequiredError(
        `duplicate rows resolve to canonical session key ${canonicalKey}`,
      );
    }
    if (match.sessionKey !== canonicalKey) {
      throw canonicalSessionKeyMigrationRequiredError(
        `non-canonical persisted row resolves to session key ${canonicalKey}`,
      );
    }
    selected = match;
  }
  return selected;
}

/** Read descriptive entry data with the logical accessor's existing candidate selection. */
export async function readResolvedSessionEntryInWorker(
  scope: LogicalSessionAccessScope,
): Promise<SessionEntry | undefined> {
  return (
    await readResolvedSessionEntriesInWorker({ ...scope, sessionKeys: [scope.sessionKey] })
  ).get(scope.sessionKey)?.entry;
}

/** One selected metadata read per store, shared by every requested logical owner. */
export async function readResolvedSessionEntriesInWorker(
  input: Omit<LogicalSessionAccessScope, "sessionKey"> & { sessionKeys: readonly string[] },
  projection: "exact" | "worktree" | "list" = "exact",
): Promise<Map<string, ResolvedSessionEntryAccessTarget>> {
  const targets = await readResolvedSessionStoreTargetsInWorker(input, projection);
  return new Map([...targets].map(([key, { storePath: _storePath, ...target }]) => [key, target]));
}

export async function readResolvedSessionStoreTargetsInWorker(
  input: Omit<LogicalSessionAccessScope, "sessionKey"> & { sessionKeys: readonly string[] },
  projection: "exact" | "worktree" | "list" = "exact",
): Promise<Map<string, ResolvedSessionEntryStoreTarget>> {
  const scope = { ...input, env: cloneEnvWithPlatformSemantics(input.env ?? process.env) };
  const actorEnv = input.env === undefined ? undefined : scope.env;
  const result = new Map<string, ResolvedSessionEntryStoreTarget>();
  const prepared = [...new Set(scope.sessionKeys)].map((requestedKey) => {
    const { agentId, canonicalKey } = resolveSessionStoreIdentity({
      ...scope,
      sessionKey: requestedKey,
    });
    return {
      agentId,
      canonicalKey,
      requestedKey,
      storePath: resolveSessionStorePathCore(scope.cfg.session?.store, { agentId, env: scope.env }),
      sessionKeys: collectCanonicalSessionLookupKeys({
        agentId,
        canonicalKey,
        requestedKey: requestedKey.trim(),
        mainKey: scope.cfg.session?.mainKey,
      }),
    };
  });
  const requests: typeof prepared = [];
  for (const request of prepared) {
    const { agentId, canonicalKey, requestedKey } = request;
    const actorScope = {
      ...scope,
      // Omitted environments belong to the captured actor's root, not process.env.
      env: actorEnv,
      sessionKey: canonicalKey,
    };
    const memory = captureMemoryExactSessionReader({ ...actorScope, agentId });
    if (memory) {
      result.set(requestedKey, {
        agentId,
        canonicalKey,
        requestedKey,
        storeKey: canonicalKey,
        storePath: memory.path,
        entry: memory.read(canonicalKey, projection === "worktree" ? "list" : undefined),
      });
      continue;
    }
    requests.push(request);
  }
  if (!requests.length) {
    return result;
  }
  const agents = new Set(requests.map(({ agentId }) => agentId));
  const read = async (targets: readonly SessionStoreTarget[], assertCurrent: () => void) => {
    // Each agent's requests share their captured default path and recovery inventory.
    const stores = [
      ...new Map(
        [...requests, ...targets.filter(({ agentId }) => agents.has(agentId))].map((target) => [
          JSON.stringify([target.agentId, target.storePath]),
          target,
        ]),
      ).values(),
    ];
    return withSessionEntriesFromStoresInWorker(
      stores.map(({ agentId, storePath }) => ({
        agentId,
        storePath,
        sessionKeys: [
          ...new Set(
            requests
              .filter((request) => request.agentId === agentId)
              .flatMap((request) => request.sessionKeys),
          ),
        ],
        projection,
        snapshotFields: [],
        env: scope.env,
      })),
      (loaded) => {
        assertCurrent();
        const entries = loaded.map(({ result: loadedResult }, index) => ({
          agentId: expectDefined(stores[index], "session store request").agentId,
          storePath: loaded[index]!.database.path,
          rows: new Map(loadedResult.entries.map((entry) => [entry.sessionKey, entry])),
        }));
        for (const request of requests) {
          const matches = entries.flatMap(({ agentId, rows }) =>
            agentId === request.agentId
              ? request.sessionKeys.flatMap((key) => rows.get(key) ?? [])
              : [],
          );
          const selected = selectCanonicalSessionEntryMatch(matches, request.canonicalKey);
          result.set(request.requestedKey, {
            agentId: request.agentId,
            canonicalKey: request.canonicalKey,
            requestedKey: request.requestedKey,
            storeKey: selected?.sessionKey ?? request.canonicalKey,
            entry: selected?.entry,
            storePath: selected
              ? entries.find(({ rows }) => rows.get(selected.sessionKey) === selected)!.storePath
              : request.storePath,
          });
        }
        return result;
      },
    );
  };
  if (!scope.cfg.session?.store?.includes("{agentId}")) {
    return read([], () => {});
  }
  const inventory = prepareSessionStoreTargetInventory(
    scope.cfg,
    [...new Set([...agents, ...listConfiguredSessionStoreAgentIds(scope.cfg)])],
    scope.env,
    "recovery",
  );
  return prepareSessionStoreTargetInventoryRead(inventory).withRead((sources, assertCurrent) =>
    read(
      sources.agents.flatMap(({ result: source }) => (source.available ? source.targets : [])),
      assertCurrent,
    ),
  );
}
