import { isDeepStrictEqual } from "node:util";
import { listAgentIds, tryResolveAmbientOwnerAgentId } from "../agents/agent-scope-config.js";
import {
  resolveSessionStoreCompatibilityAgentId,
  tryResolveLegacyCompatibilityAgentId,
} from "../config/legacy.default-agent-owner.js";
import {
  projectSessionSharingEntry,
  retainPreparedSessionSharingFacts,
} from "../config/sessions/session-accessor.sqlite-entry-cache.js";
import { readSessionEntriesFromStoreInWorker } from "../config/sessions/session-entry-read-runtime.js";
import {
  isSessionStoreReadCandidateCurrent,
  type SessionStoreReadCandidate,
} from "../config/sessions/session-store-read-candidates.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { assertExistingDatabaseIdentity } from "../infra/sqlite-worker-identity.js";
import { SessionMutationFactsUnavailableError } from "./session-sharing-incognito.js";
import type { PreparedSessionMutationFacts } from "./session-sharing-policy.js";
import type { PreparedSessionFactsSource } from "./session-sharing-source.types.js";

function routeFacts(cfg: OpenClawConfig) {
  return {
    agents: listAgentIds(cfg),
    storeOwner: resolveSessionStoreCompatibilityAgentId(cfg),
    compatibilityOwner: tryResolveLegacyCompatibilityAgentId(cfg),
    systemOwner: tryResolveAmbientOwnerAgentId(cfg),
    store: cfg.session?.store,
    mainKey: cfg.session?.mainKey,
    scope: cfg.session?.scope,
  };
}

export function captureSessionMutationRouting(
  cfg: OpenClawConfig,
  changed: () => Error = () => new SessionMutationFactsUnavailableError(),
) {
  const route = routeFacts(cfg);
  return (current: OpenClawConfig) => {
    if (!isDeepStrictEqual(routeFacts(current), route)) {
      throw changed();
    }
  };
}
export type PreparedSessionSourceFacts = PreparedSessionMutationFacts & {
  sourcePath?: string;
  sourceAgentId?: string;
};

export type { PreparedSessionFactsSource } from "./session-sharing-source.types.js";

/** Physical selection phase of the retained sharing owner; it never substitutes current routing. */
export async function prepareCapturedSessionSharingSource(params: {
  source: PreparedSessionFactsSource;
  assertCurrent: () => void;
  candidates: readonly SessionStoreReadCandidate[];
  retainedReads: ReadonlyMap<string, ReturnType<typeof retainPreparedSessionSharingFacts>>;
}) {
  const source = { ...params.source };
  const assertSource = () => {
    params.assertCurrent();
    if (!params.candidates.every(isSessionStoreReadCandidateCurrent)) {
      throw new SessionMutationFactsUnavailableError();
    }
    source.assertCurrent();
    assertExistingDatabaseIdentity(
      source.path,
      `file:${source.databaseIdentity}`,
      source.databaseBirthtime,
    );
  };
  assertSource();
  // Acquire publication custody before the native exact row read yields.
  const retained = params.retainedReads.get(
    `file:${source.databaseIdentity}\0${source.canonicalKey}`,
  );
  if (!retained) {
    throw new SessionMutationFactsUnavailableError();
  }
  const loaded = await readSessionEntriesFromStoreInWorker({
    agentId: source.agentId,
    storePath: source.path,
    sessionKeys: [source.canonicalKey],
    projection: "sharing",
    includeAuthorization: true,
    preparedSource: { ...source, assertCurrent: assertSource },
  });
  assertSource();
  const sharing = loaded.sharing;
  const identity = loaded.databaseIdentity;
  const entry = loaded.entries.find((row) => row.sessionKey === source.canonicalKey)?.entry;
  if (
    !sharing ||
    !identity ||
    !identity.incarnation ||
    !entry ||
    identity.identity !== source.databaseIdentity ||
    identity.birthtime !== source.databaseBirthtime ||
    identity.filename !== source.path ||
    sharing.source.path !== source.path ||
    sharing.source.agentId !== source.agentId ||
    sharing.databaseIdentity !== `file:${source.databaseIdentity}`
  ) {
    throw new SessionMutationFactsUnavailableError();
  }
  retained.initialize({
    entry: projectSessionSharingEntry(entry),
    placeholder: sharing.placeholders.find((row) => row.sessionKey === source.canonicalKey),
    membership: new Set(
      sharing.members.find((row) => row.sessionKey === source.canonicalKey)?.identityIds,
    ),
  });
  const storageTarget = Object.freeze({
    agentId: source.agentId,
    canonicalKey: source.canonicalKey,
    storePath: source.storePath,
  });
  const readFacts = (): PreparedSessionSourceFacts => {
    assertSource();
    const current = retained.readCurrent();
    if (
      !current?.entry ||
      current.entry.sessionId !== entry.sessionId ||
      current.entry.lifecycleRevision !== entry.lifecycleRevision
    ) {
      throw new SessionMutationFactsUnavailableError();
    }
    return {
      sourcePath: source.path,
      sourceAgentId: source.agentId,
      target: {
        ...storageTarget,
        storeKey: source.canonicalKey,
        storeKeys: [source.canonicalKey],
        entry: current.entry,
      },
      membership: current.membership,
    };
  };
  readFacts();
  return { storageTarget, assertSource, readFacts };
}
