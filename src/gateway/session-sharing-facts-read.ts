import { stat } from "node:fs/promises";
import path from "node:path";
import {
  retainPreparedSessionSharingFacts,
  projectSessionSharingEntry,
} from "../config/sessions/session-accessor.sqlite-entry-cache.js";
import { readSessionEntriesFromStoreInWorker } from "../config/sessions/session-entry-read-runtime.js";
import type {
  SessionEntryReadSourcePreparation,
  SessionStoreWorkerReadScope,
} from "../config/sessions/session-entry-read-runtime.types.js";
import type { SessionStoreReadCandidate } from "../config/sessions/session-store-read-candidates.js";
import type { observeDiagnosticsTimelinePhases } from "../infra/diagnostics-timeline.js";
import type { DatabasePathIdentity } from "../infra/sqlite-worker-identity.js";
import { assertDatabaseFileIdentity } from "../infra/sqlite-worker-identity.js";
import { registerOpenClawAgentDatabaseReadCandidateResource } from "../state/openclaw-agent-db-resources.js";
import { SessionMutationFactsUnavailableError } from "./session-sharing-incognito.js";
import type {
  SessionFactsRequest,
  PreparedSessionSharingSource,
} from "./session-sharing-target.types.js";

/** Reuse committed metadata/member facts; only missing rows need creation placeholders. */
async function readSessionSharingFactsInWorker(
  input: Pick<SessionStoreWorkerReadScope, "agentId" | "storePath" | "env"> & {
    sessionKeys: readonly string[];
  },
  prepareSource: SessionEntryReadSourcePreparation,
) {
  let physicalSource: { agentId: string; path: string } | undefined;
  const captureSource: SessionEntryReadSourcePreparation = (source, identity) => {
    physicalSource = source;
    prepareSource(source, identity);
  };
  const request = {
    ...input,
    projection: "full" as const,
    snapshotFields: [],
    includeMembers: true,
    includeAuthorization: true,
  };
  // Match ordinary metadata reads so committed actor facts serve warmed admission.
  let loaded = await readSessionEntriesFromStoreInWorker(request, captureSource);
  if (loaded.entries.length === 0) {
    // A cold absence also needs the durable placeholder used by creation receipts.
    loaded = await readSessionEntriesFromStoreInWorker(
      { ...request, projection: "sharing" },
      captureSource,
    );
  }
  return {
    ...loaded,
    sharing:
      (loaded.snapshotSource
        ? {
            source: { agentId: loaded.snapshotSource.agentId, path: loaded.snapshotSource.path },
            databaseIdentity: `file:${loaded.snapshotSource.databaseIdentity}`,
            placeholders: loaded.sharing?.placeholders ?? [],
            members:
              loaded.sharing?.members ??
              loaded.entries.map(({ sessionKey }) => ({
                sessionKey,
                identityIds: (loaded.members?.[sessionKey] ?? []).map(
                  (member) => member.identityId,
                ),
              })),
          }
        : loaded.sharing) ??
      (loaded.databaseIdentity && physicalSource
        ? {
            source: physicalSource,
            databaseIdentity: `file:${loaded.databaseIdentity.identity}`,
            placeholders: [],
            members: loaded.entries.map(({ sessionKey }) => ({
              sessionKey,
              identityIds: (loaded.members?.[sessionKey] ?? []).map((member) => member.identityId),
            })),
          }
        : undefined),
  };
}

/** Keep the acquired publication facts with the read that initializes and reconciles them. */
export function createSessionSharingFactAcquisition(
  params: Pick<SessionFactsRequest, "followLifecycle" | "followTranscript"> & {
    scope: "sharing" | "session-access";
    inspection: boolean;
    releases: Array<() => void>;
    release(this: void): void;
    assertActive(): void;
    assertRoutingCurrent(): void;
    phases: Pick<ReturnType<typeof observeDiagnosticsTimelinePhases>, "mark">;
  },
) {
  const paths = new Set<string>();
  const reads = new Map<string, ReturnType<typeof retainPreparedSessionSharingFacts>>();
  const initialized = new Set<string>();
  const sources: Array<{ agentId: string; path: string; identity: string; birthtime: string }> = [];
  const capture = (
    sourcePath: string,
    sessionKeys: readonly string[],
    identity: DatabasePathIdentity,
  ) => {
    if (identity.birthtime === undefined) {
      return undefined;
    }
    paths.add(path.resolve(sourcePath));
    paths.add(identity.canonicalPath);
    for (const sessionKey of sessionKeys) {
      const key = `${identity.key}\0${sessionKey}`;
      if (!reads.has(key)) {
        const retained = retainPreparedSessionSharingFacts({
          databaseIdentity: identity.key,
          sessionKey,
          followLifecycle: params.followLifecycle,
          followTranscript: params.followTranscript,
          acquiring: true,
        });
        reads.set(key, retained);
        params.releases.push(retained.release);
      }
    }
    return identity;
  };
  return {
    paths,
    sources,
    capture,
    retainCandidate(candidate: SessionStoreReadCandidate) {
      for (const pathname of new Set([candidate.path, candidate.physicalPath])) {
        params.releases.push(
          registerOpenClawAgentDatabaseReadCandidateResource({
            ...candidate,
            path: pathname,
            revoke: params.release,
            close: async () => params.release(),
          }),
        );
      }
    },
    get(databaseIdentity: string, sessionKey: string) {
      const key = `${databaseIdentity}\0${sessionKey}`;
      return initialized.has(key) ? reads.get(key) : undefined;
    },
    prepareRead() {
      const pending = [...reads.values()].flatMap((read) => read.prepareRead() ?? []);
      return pending.length > 0 ? Promise.all(pending).then(() => {}) : undefined;
    },
    async read(
      this: void,
      input: Parameters<typeof readSessionSharingFactsInWorker>[0],
      publishSource: (source: PreparedSessionSharingSource) => void,
    ) {
      params.assertActive();
      params.phases.mark("sessionFacts.rows");
      const loaded = await readSessionSharingFactsInWorker(input, (source, identity) => {
        params.assertActive();
        if (capture(source.path, input.sessionKeys, identity)) {
          paths.add(path.resolve(input.storePath));
        }
      });
      params.phases.mark("sessionFacts.selection");
      params.assertActive();
      const store = Object.fromEntries(
        loaded.entries.map(({ sessionKey, entry }) => [sessionKey, entry]),
      );
      if (!loaded.sharing) {
        return store;
      }
      const source = loaded.databaseIdentity;
      const snapshotSource = loaded.snapshotSource;
      const birthtime = snapshotSource?.databaseBirthtime ?? source?.birthtime;
      const identity = snapshotSource?.databaseIdentity ?? source?.identity;
      if (
        !source ||
        !source.incarnation ||
        identity === undefined ||
        (snapshotSource?.path ?? source.filename) !== loaded.sharing.source.path ||
        `file:${identity}` !== loaded.sharing.databaseIdentity ||
        birthtime === undefined
      ) {
        throw new SessionMutationFactsUnavailableError();
      }
      if (!params.inspection) {
        const current = await stat(loaded.sharing.source.path, { bigint: true });
        params.assertActive();
        params.assertRoutingCurrent();
        assertDatabaseFileIdentity(current, { key: loaded.sharing.databaseIdentity, birthtime });
      }
      sources.push({
        ...loaded.sharing.source,
        identity: loaded.sharing.databaseIdentity,
        birthtime,
      });
      publishSource({
        facts: loaded.sharing,
        source: {
          ...loaded.sharing.source,
          databaseIdentity: identity,
          databaseBirthtime: birthtime,
        },
      });
      for (const sessionKey of input.sessionKeys) {
        const key = `${loaded.sharing.databaseIdentity}\0${sessionKey}`;
        const retained = reads.get(key);
        if (!retained) {
          throw new SessionMutationFactsUnavailableError();
        }
        if (!initialized.has(key)) {
          const entry = store[sessionKey];
          retained.initialize({
            entry: entry ? projectSessionSharingEntry(entry) : undefined,
            placeholder: loaded.sharing.placeholders.find((row) => row.sessionKey === sessionKey),
            membership: new Set(
              loaded.sharing.members.find((row) => row.sessionKey === sessionKey)?.identityIds,
            ),
          });
          initialized.add(key);
        }
        const pending = retained.prepareRead();
        if (pending) {
          params.phases.mark("sessionFacts.publication");
          await pending;
          params.phases.mark("sessionFacts.selection");
          params.assertActive();
        }
        const current = retained.readCurrent(params.scope);
        if (!current) {
          throw new SessionMutationFactsUnavailableError();
        }
        if (current.entry) {
          store[sessionKey] = current.entry;
        }
      }
      return store;
    },
  };
}
