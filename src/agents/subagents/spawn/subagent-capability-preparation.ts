import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { resolveSessionStorePathCore } from "../../../config/sessions/paths.js";
import { withSessionEntryReadOnlyInWorker } from "../../../config/sessions/session-entry-read-runtime.js";
import type { SessionEntry } from "../../../config/sessions/types.js";
import type { OpenClawConfig } from "../../../config/types.openclaw.js";
import { resolveSessionStoreAgentId } from "../../../gateway/session-store-key.js";
import { parseAgentSessionKey } from "../../../routing/session-key.js";
import { requiresSubagentCapabilityStore } from "./subagent-capabilities.js";
import type { SessionCapabilityLookup } from "./subagent-session-store.js";

const MAX_CAPABILITY_LINEAGE_ENTRIES = 128;
const MAX_CAPABILITY_LINEAGE_DEPTH = 32;

type CapabilitySessionScope = {
  sessionKey: string;
  agentId: string;
  storePath: string;
};

/** Retain exact worker-read facts and their owners through one policy admission. */
export async function withPreparedSubagentCapabilityStore<T>(params: {
  cfg: OpenClawConfig;
  preparedSessionEntry: {
    sessionKey: string;
    agentId?: string;
    entry: SessionEntry | undefined;
  };
  storePath?: string;
  extraSessionKeys?: readonly string[];
  assertCurrent: () => void;
  consume: (prepared: {
    store: SessionCapabilityLookup;
    sessionScopes: readonly CapabilitySessionScope[];
    readEntry: (sessionKey: string) => SessionEntry | undefined;
    assertCurrent: () => void;
  }) => Promise<T>;
}): Promise<T> {
  const rootKey = params.preparedSessionEntry.sessionKey;
  const rootAgentId = resolveSessionStoreAgentId(
    params.cfg,
    rootKey,
    params.preparedSessionEntry.agentId,
  );
  const scopes = new Map<string, CapabilitySessionScope>([
    [
      rootKey,
      {
        sessionKey: rootKey,
        agentId: rootAgentId,
        storePath:
          params.storePath ??
          resolveSessionStorePathCore(params.cfg.session?.store, { agentId: rootAgentId }),
      },
    ],
  ]);
  const entries = new Map<string, SessionEntry | undefined>([
    [rootKey, params.preparedSessionEntry.entry],
  ]);
  const guards: Array<() => void> = [];
  const pending = new Set(params.extraSessionKeys ?? []);
  let active = true;
  const assertCurrent = () => {
    if (!active) {
      throw new Error("Prepared capability lineage is no longer active.");
    }
    params.assertCurrent();
    for (const guard of guards) {
      guard();
    }
  };
  const links = (entry: SessionEntry | undefined) =>
    [entry?.spawnedBy, entry?.completionOwnerSessionKey]
      .map(normalizeOptionalString)
      .filter((key): key is string => Boolean(key));
  const enqueue = (entry: SessionEntry | undefined) => {
    for (const key of links(entry)) {
      if (!parseAgentSessionKey(key) && key !== "global" && key !== "unknown") {
        throw new Error("Capability lineage requires canonical agent session keys.");
      }
      // Ordinary requester keys terminate capability ancestry; only candidate
      // child keys can require another persisted envelope.
      if (requiresSubagentCapabilityStore(key) && !entries.has(key)) {
        pending.add(key);
      }
    }
  };
  enqueue(params.preparedSessionEntry.entry);
  const readEntry = (sessionKey: string) => {
    assertCurrent();
    if (
      !entries.has(sessionKey) &&
      (requiresSubagentCapabilityStore(sessionKey) ||
        (!parseAgentSessionKey(sessionKey) && sessionKey !== "global" && sessionKey !== "unknown"))
    ) {
      throw new Error("Capability policy requested an unprepared lineage entry.");
    }
    return entries.get(sessionKey);
  };
  const validateLineage = () => {
    const activeKeys = new Set<string>();
    const depths = new Map<string, number>();
    const visit = (key: string): number => {
      const knownDepth = depths.get(key);
      if (knownDepth !== undefined) {
        return knownDepth;
      }
      if (activeKeys.has(key)) {
        throw new Error("Capability lineage is cyclic or exceeds the supported depth.");
      }
      activeKeys.add(key);
      let depth = 1;
      for (const related of links(entries.get(key))) {
        depth = Math.max(depth, 1 + visit(related));
      }
      activeKeys.delete(key);
      if (depth > MAX_CAPABILITY_LINEAGE_DEPTH) {
        throw new Error("Capability lineage is cyclic or exceeds the supported depth.");
      }
      depths.set(key, depth);
      return depth;
    };
    for (const key of [rootKey, ...(params.extraSessionKeys ?? [])]) {
      visit(key);
    }
  };
  const prepare = async (): Promise<T> => {
    assertCurrent();
    const key = pending.values().next().value;
    if (key === undefined) {
      validateLineage();
      return params.consume({
        store: {
          authoritative: true,
          get: readEntry,
          getById: () => undefined,
          assertAvailable: assertCurrent,
        },
        sessionScopes: [...scopes.values()],
        readEntry,
        assertCurrent,
      });
    }
    pending.delete(key);
    if (entries.has(key)) {
      return prepare();
    }
    if (entries.size >= MAX_CAPABILITY_LINEAGE_ENTRIES) {
      throw new Error("Capability lineage exceeds the supported entry count.");
    }
    const agentId = parseAgentSessionKey(key)?.agentId;
    if (!agentId || key !== key.trim()) {
      throw new Error("Capability lineage requires canonical agent session keys.");
    }
    const scope = {
      agentId,
      sessionKey: key,
      storePath:
        agentId === rootAgentId && params.storePath
          ? params.storePath
          : resolveSessionStorePathCore(params.cfg.session?.store, { agentId }),
    };
    scopes.set(key, scope);
    return withSessionEntryReadOnlyInWorker(
      {
        ...scope,
        projection: "list",
        canonicalValidation: "selected",
      },
      params.assertCurrent,
      async (read, assertReadCurrent) => {
        if (!read.ok) {
          throw new Error("Capability lineage owner is unavailable.", { cause: read.error });
        }
        guards.push(assertReadCurrent);
        entries.set(key, read.value);
        enqueue(read.value);
        try {
          return await prepare();
        } finally {
          guards.pop();
        }
      },
    );
  };
  try {
    const result = await prepare();
    assertCurrent();
    return result;
  } finally {
    active = false;
  }
}
