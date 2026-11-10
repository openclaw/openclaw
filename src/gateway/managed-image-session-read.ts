import path from "node:path";
import { extractErrorCode } from "@openclaw/normalization-core/error-coercion";
import { resolveStateDir } from "../config/paths.js";
import { withSessionActorStorage } from "../config/sessions/session-actor-storage-acquisition.js";
import type { SessionExactEntriesWorkerResult } from "../config/sessions/session-entry-read.types.js";
import { captureSessionStoreReadCandidate } from "../config/sessions/session-store-read-candidates.js";
import { prepareSessionStoreTargetInventory } from "../config/sessions/session-store-target-inventory.js";
import { prepareSessionStoreTargetInventoryRead } from "../config/sessions/session-store-target-runtime.js";
import {
  withSessionHistoryWorkerDatabase,
  withSessionHistoryWorkerDatabases,
} from "../config/sessions/session-transcript-worker-runtime.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { assertExistingDatabaseIdentity } from "../infra/sqlite-worker-identity.js";
import { isIncognitoSessionKey } from "../routing/session-key.js";
import { normalizeSessionKeyPreservingOpaquePeerIds } from "../sessions/session-key-utils.js";
import { OPENCLAW_AGENT_SCHEMA_VERSION } from "../state/openclaw-agent-db-contract.js";
import { prepareOpenClawAgentDatabaseRegistrySnapshotRead } from "../state/openclaw-agent-db-registry-listing.js";
import { SessionMetadataUnavailableError } from "../state/session-metadata-unavailable-error.js";
import type { SessionTranscriptReadScope } from "./session-transcript-readers.js";
import { resolveGatewaySessionStoreTargetInWorker } from "./session-utils-store-worker.js";

/** A cleanup pass discovers older sources only when current history does not own a reference. */
export function prepareManagedImageRetentionRead(params: {
  stateDir: string;
  assertCurrent: () => void;
}) {
  const env = { ...process.env, OPENCLAW_STATE_DIR: params.stateDir };
  let snapshot:
    | ReturnType<ReturnType<typeof prepareOpenClawAgentDatabaseRegistrySnapshotRead>["read"]>
    | undefined;
  let assertRegistryCurrent = params.assertCurrent;
  return {
    assertCurrent: () => assertRegistryCurrent(),
    async read(
      target: { agentId: string; sessionKey: string },
      consume: (
        scope: SessionTranscriptReadScope,
        assertCurrent: () => void,
      ) => Promise<Set<string> | null>,
    ): Promise<Set<string> | null> {
      params.assertCurrent();
      const registry = await (snapshot ??= prepareOpenClawAgentDatabaseRegistrySnapshotRead({
        env,
        includeIncompatibleSchemaVersions: true,
      }).read());
      assertRegistryCurrent = () => {
        params.assertCurrent();
        registry.assertCurrent();
      };
      assertRegistryCurrent();
      if (registry.result.status !== "available") {
        return null;
      }
      const matches = new Set<string>();
      const visited = new Set<string>();
      for (const database of registry.result.entries) {
        // Old or unverifiable sources cannot establish destructive absence.
        if (database.schemaVersion !== OPENCLAW_AGENT_SCHEMA_VERSION) {
          return null;
        }
        try {
          const candidate = captureSessionStoreReadCandidate(database.path);
          const key = JSON.stringify([database.agentId, candidate.physicalPath]);
          if (visited.has(key)) {
            continue;
          }
          visited.add(key);
          const found = await withSessionHistoryWorkerDatabase(
            {
              agentId: database.agentId,
              path: candidate.physicalPath,
              requestedPaths: [candidate.path],
              env,
            },
            async (reader) => {
              const exact = await reader.readExactEntries({
                sessionKeys: [target.sessionKey],
                projection: "sharing",
                env,
              });
              // A missing physical database also returns no entries, without this proof.
              if (!exact.sharing || exact.sharing.placeholders.length > 0) {
                return null;
              }
              const identity = exact.sharing.databaseIdentity;
              const assertCurrent = () => {
                assertRegistryCurrent();
                reader.assertCurrent();
                if (
                  captureSessionStoreReadCandidate(candidate.path).physicalPath !==
                  candidate.physicalPath
                ) {
                  throw new Error("Managed media retained session store changed during read");
                }
                assertExistingDatabaseIdentity(candidate.physicalPath, identity);
              };
              assertCurrent();
              const scope = {
                ...target,
                databaseAgentId: database.agentId,
                storePath: candidate.physicalPath,
                env,
              };
              let entry = exact.entries[0]?.entry;
              if (!entry) {
                const read = await reader.readEntryResult({ scope });
                assertCurrent();
                if (!read.ok) {
                  return null;
                }
                entry = read.value;
              }
              if (!entry) {
                return new Set<string>();
              }
              const refs = await consume(
                { ...scope, sessionEntry: entry, sessionId: entry.sessionId },
                assertCurrent,
              );
              assertCurrent();
              return refs;
            },
          );
          assertRegistryCurrent();
          if (found === null) {
            return null;
          }
          for (const match of found) {
            matches.add(match);
          }
        } catch {
          assertRegistryCurrent();
          return null;
        }
      }
      assertRegistryCurrent();
      return matches;
    },
  };
}

/** Serving keeps discovery and physical readers alive through response publication. */
export async function withManagedImageSessionRead<T>(
  params: {
    cfg: OpenClawConfig;
    sessionKey: string;
    agentId: string;
    stateDir: string;
    assertCurrent: () => void;
    unavailable?: T;
  },
  consume: (scope: SessionTranscriptReadScope, assertCurrent: () => void) => Promise<T>,
): Promise<T | null> {
  const { cfg, sessionKey, agentId, stateDir } = params;
  params.assertCurrent();
  const incognitoScope = {
    agentId,
    sessionKey: normalizeSessionKeyPreservingOpaquePeerIds(sessionKey),
    storePath: cfg.session?.store,
    env: { ...process.env, OPENCLAW_STATE_DIR: stateDir },
  };
  if (isIncognitoSessionKey(incognitoScope.sessionKey)) {
    const assertCurrent = params.assertCurrent;
    return (
      (await withSessionActorStorage(
        incognitoScope,
        {
          lifetime: { assertCurrent, assertReadable: assertCurrent },
          authority: { assertCurrent, authorize: assertCurrent },
        },
        (binding) => {
          const entry = binding.actor.snapshot(binding.authority)?.entry;
          if (!entry) {
            return null;
          }
          return consume(
            {
              ...incognitoScope,
              storePath: binding.path,
              sessionEntry: entry,
              sessionId: entry.sessionId,
            },
            () => {
              const current = binding.actor.snapshot(binding.authority)?.entry;
              if (
                current?.sessionId !== entry.sessionId ||
                current?.lifecycleRevision !== entry.lifecycleRevision
              ) {
                throw new Error("Managed media session authority changed");
              }
            },
          );
        },
      )) ?? null
    );
  }
  const { candidates, ...prepared } = prepareSessionStoreTargetInventory(cfg, [agentId], {
    ...process.env,
    OPENCLAW_STATE_DIR: stateDir,
  });
  const inventoryRead = prepareSessionStoreTargetInventoryRead({ ...prepared, candidates });
  const assertSelectionCurrent = () => {
    params.assertCurrent();
    for (const candidate of candidates) {
      if (
        captureSessionStoreReadCandidate(candidate.path, candidate.scope).physicalPath !==
        candidate.physicalPath
      ) {
        throw new Error("Managed media session store changed during read");
      }
    }
  };
  const result = inventoryRead.withRead(async (inventory, assertDiscoveryCurrent) => {
    const source = inventory.agents[0];
    if (!source?.result.available) {
      return params.unavailable ?? null;
    }
    return withSessionHistoryWorkerDatabases(
      source.reads.map(({ database }) => ({ ...database, env: prepared.env })),
      async (readers) => {
        const identities = new Map<string, string>();
        const assertCurrent = () => {
          assertDiscoveryCurrent();
          for (const reader of readers) {
            reader.assertCurrent();
          }
          for (const [pathname, identity] of identities) {
            assertExistingDatabaseIdentity(pathname, identity);
          }
        };
        let matched: SessionTranscriptReadScope | undefined;
        for (const [index, { database }] of source.reads.entries()) {
          const scope = {
            agentId,
            databaseAgentId: database.agentId,
            storePath: database.path,
            env: prepared.env,
            sessionKey,
          };
          const reader = readers[index]!;
          let exact: SessionExactEntriesWorkerResult;
          try {
            exact = await reader.readExactEntries({
              sessionKeys: [sessionKey],
              projection: "sharing",
              env: prepared.env,
            });
          } catch (error) {
            assertCurrent();
            if (
              params.unavailable !== undefined ||
              extractErrorCode(error) === "SESSION_CANONICAL_KEY_MIGRATION_REQUIRED" ||
              (error instanceof SessionMetadataUnavailableError &&
                error.reason === "schema-missing")
            ) {
              return params.unavailable ?? null;
            }
            throw error;
          }
          if (exact.sharing) {
            identities.set(database.path, exact.sharing.databaseIdentity);
          }
          assertCurrent();
          if (exact.sharing?.placeholders.length) {
            return params.unavailable ?? null;
          }
          let entry = exact.entries[0]?.entry;
          if (!entry) {
            const read = await reader.readEntryResult({ scope }).catch((error: unknown) => {
              if (params.unavailable !== undefined) {
                return undefined;
              }
              throw error;
            });
            assertCurrent();
            if (!read?.ok) {
              return params.unavailable ?? null;
            }
            entry = read.value;
          }
          if (entry) {
            if (matched) {
              return params.unavailable ?? null;
            }
            matched = { ...scope, sessionEntry: entry, sessionId: entry.sessionId };
          }
        }
        if (matched) {
          return consume(matched, assertCurrent);
        }
        if (path.resolve(stateDir) !== path.resolve(resolveStateDir())) {
          return null;
        }
        const fallback = await resolveGatewaySessionStoreTargetInWorker({
          cfg: prepared.config,
          key: sessionKey,
          agentId,
          env: prepared.env,
          assertActive: assertCurrent,
        });
        assertCurrent();
        if (!fallback.readSource) {
          return null;
        }
        const database = fallback.readSource;
        return withSessionHistoryWorkerDatabases(
          [{ ...database, env: prepared.env }],
          async ([reader]) => {
            const scope = {
              agentId,
              databaseAgentId: database.agentId,
              sessionKey: fallback.canonicalKey,
              storePath: database.path,
              env: prepared.env,
            };
            const read = await reader!.readEntryResult({ scope }).catch((error: unknown) => {
              if (params.unavailable !== undefined) {
                return undefined;
              }
              throw error;
            });
            const assertFallbackCurrent = () => {
              assertCurrent();
              reader!.assertCurrent();
            };
            assertFallbackCurrent();
            if (!read?.ok) {
              return params.unavailable ?? null;
            }
            if (!read.value) {
              return null;
            }
            return consume(
              {
                ...scope,
                sessionKey,
                sessionId: read.value.sessionId,
                sessionEntry: read.value,
              },
              assertFallbackCurrent,
            );
          },
        );
      },
    );
  }, assertSelectionCurrent);
  return result.catch((error: unknown) => {
    if (
      params.unavailable !== undefined &&
      (error instanceof SessionMetadataUnavailableError ||
        extractErrorCode(error) === "SESSION_CANONICAL_KEY_MIGRATION_REQUIRED")
    ) {
      return params.unavailable;
    }
    throw error;
  });
}
