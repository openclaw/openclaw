import { readSessionEntriesFromStoreInWorker } from "../config/sessions/session-entry-read-runtime.js";
import type {
  SessionEntryReadSourcePreparation,
  SessionStoreWorkerReadScope,
} from "../config/sessions/session-entry-read-runtime.types.js";

/** Reuse committed metadata/member facts; only missing rows need creation placeholders. */
export async function readSessionSharingFactsInWorker(
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
      loaded.sharing ??
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
