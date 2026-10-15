import {
  projectSessionSharingEntry,
  retainPreparedSessionSharingFacts,
} from "../config/sessions/session-accessor.sqlite-entry-cache.js";
import { readSessionEntriesFromStoreInWorker } from "../config/sessions/session-entry-read-runtime.js";
import { SessionMutationFactsUnavailableError } from "./session-sharing-incognito.js";
import type { PreparedSessionFactsSource } from "./session-sharing-source.types.js";
import type { PreparedSessionSourceFacts } from "./session-sharing-target.types.js";

export type { PreparedSessionFactsSource } from "./session-sharing-source.types.js";

/** Physical selection phase of the retained sharing owner; it never substitutes current routing. */
export async function prepareCapturedSessionSharingSource(params: {
  source: PreparedSessionFactsSource;
  assertCurrent: () => void;
  retainedReads: ReadonlyMap<string, ReturnType<typeof retainPreparedSessionSharingFacts>>;
}) {
  const source = { ...params.source };
  // The parent retains native resources and publishes revocation; the loaded
  // worker result below proves physical identity once, before resident reads.
  const assertSource = () => {
    params.assertCurrent();
    source.assertCurrent();
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
  const readSource = {
    agentId: source.agentId,
    path: source.path,
    databaseIdentity: source.databaseIdentity,
    databaseBirthtime: source.databaseBirthtime,
  };
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
      readSource,
      target: {
        ...storageTarget,
        readSource,
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
