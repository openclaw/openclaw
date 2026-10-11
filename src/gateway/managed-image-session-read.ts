import path from "node:path";
import { extractErrorCode } from "@openclaw/normalization-core/error-coercion";
import { resolveStateDir } from "../config/paths.js";
import { loadExactSessionEntryReadOnlyResult } from "../config/sessions/session-accessor.sqlite-entry-availability.js";
import { resolveSessionEntry } from "../config/sessions/session-accessor.sqlite-exact-read.js";
import type { SessionExactEntriesWorkerResult } from "../config/sessions/session-entry-read.types.js";
import {
  captureIncognitoSessionSource,
  withIncognitoSessionEntry,
} from "../config/sessions/session-incognito-binding.js";
import { captureSessionStoreReadCandidate } from "../config/sessions/session-store-read-candidates.js";
import { prepareSessionStoreTargetInventory } from "../config/sessions/session-store-target-inventory.js";
import { prepareSessionStoreTargetInventoryRead } from "../config/sessions/session-store-target-runtime.js";
import { withSessionHistoryWorkerDatabases } from "../config/sessions/session-transcript-worker-runtime.js";
import {
  resolveExistingAgentSessionStoreTargetsReadOnlyResult,
  type SessionStoreTargetsReadCache,
} from "../config/sessions/targets-read-availability.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { assertExistingDatabaseIdentity } from "../infra/sqlite-worker-identity.js";
import { normalizeSessionKeyPreservingOpaquePeerIds } from "../sessions/session-key-utils.js";
import { SessionMetadataUnavailableError } from "../state/session-metadata-unavailable-error.js";
import type { SessionTranscriptReadScope } from "./session-transcript-readers.js";
import { resolveGatewaySessionStoreTargetInWorker } from "./session-utils-store-worker.js";
import { loadGatewaySessionEntryReadOnly } from "./session-utils-store.js";

export type SessionStoreAvailabilityRead = ReturnType<
  typeof resolveExistingAgentSessionStoreTargetsReadOnlyResult
>;

/** Native cleanup selection remains available until production incognito acquisition cuts over. */
export function resolveNativeManagedImageSessionRead(params: {
  cfg: OpenClawConfig;
  sessionKey: string;
  agentId?: string;
  ownerAgentId: string;
  env: NodeJS.ProcessEnv;
  stateDir?: string;
  storeAvailabilityCache?: Map<string, SessionStoreAvailabilityRead>;
  storeTargetsReadCache?: SessionStoreTargetsReadCache;
}): { kind: "ready"; scope: SessionTranscriptReadScope } | { kind: "missing" | "unavailable" } {
  const {
    cfg,
    sessionKey,
    agentId,
    ownerAgentId,
    env,
    stateDir,
    storeAvailabilityCache,
    storeTargetsReadCache,
  } = params;
  const discovery =
    storeAvailabilityCache?.get(ownerAgentId) ??
    resolveExistingAgentSessionStoreTargetsReadOnlyResult(cfg, ownerAgentId, {
      cache: storeTargetsReadCache,
      ...(stateDir ? { env: { ...process.env, OPENCLAW_STATE_DIR: stateDir } } : {}),
    });
  storeAvailabilityCache?.set(ownerAgentId, discovery);
  if (!discovery.available) {
    return { kind: "unavailable" };
  }
  const usesRuntimeState = !stateDir || path.resolve(stateDir) === path.resolve(resolveStateDir());
  type SessionEntry = ReturnType<typeof loadGatewaySessionEntryReadOnly>["entry"];
  let matched: { entry: NonNullable<SessionEntry>; storePath: string } | undefined;
  for (const target of discovery.targets) {
    const readTarget = {
      agentId: ownerAgentId,
      clone: false,
      env,
      sessionKey,
      storePath: target.storePath,
    };
    let targetEntry: SessionEntry;
    try {
      const exact = loadExactSessionEntryReadOnlyResult(readTarget);
      if (!exact.found) {
        return { kind: "unavailable" };
      }
      targetEntry = exact.value?.entry;
      if (!targetEntry) {
        targetEntry = resolveSessionEntry(readTarget, { readOnly: true }).existing;
      }
    } catch {
      return { kind: "unavailable" };
    }
    if (targetEntry) {
      if (matched) {
        return { kind: "unavailable" };
      }
      matched = { entry: targetEntry, storePath: target.storePath };
    }
  }
  let entry: SessionEntry = matched?.entry;
  let storePath = matched?.storePath ?? discovery.targets[0]?.storePath ?? "";
  if (!entry && usesRuntimeState) {
    const loaded = loadGatewaySessionEntryReadOnly(sessionKey, { agentId: ownerAgentId });
    const exact = loadExactSessionEntryReadOnlyResult({
      agentId: ownerAgentId,
      clone: false,
      sessionKey,
      storePath: loaded.storePath,
    });
    if (!exact.found) {
      return { kind: "unavailable" };
    }
    entry = exact.value?.entry ?? loaded.entry;
    storePath = loaded.storePath;
  }
  const sessionId = entry?.sessionId;
  return sessionId
    ? { kind: "ready", scope: { agentId, sessionEntry: entry, sessionId, sessionKey, storePath } }
    : { kind: "missing" };
}

/** Serving keeps discovery and physical readers alive through response publication. */
export async function withManagedImageSessionRead<T>(
  params: {
    cfg: OpenClawConfig;
    sessionKey: string;
    agentId: string;
    stateDir: string;
    assertCurrent: () => void;
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
  const binding = captureIncognitoSessionSource(incognitoScope);
  if (binding) {
    return withIncognitoSessionEntry(
      binding,
      incognitoScope.sessionKey,
      params.assertCurrent,
      async (entry, assertCurrent) =>
        entry && !("kind" in binding)
          ? consume(
              {
                ...incognitoScope,
                storePath: binding.actor.path,
                sessionEntry: entry,
                sessionId: entry.sessionId,
              },
              assertCurrent,
            )
          : null,
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
  return inventoryRead.withRead(async (inventory, assertDiscoveryCurrent) => {
    const source = inventory.agents[0];
    if (!source?.result.available) {
      return null;
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
              extractErrorCode(error) === "SESSION_CANONICAL_KEY_MIGRATION_REQUIRED" ||
              (error instanceof SessionMetadataUnavailableError &&
                error.reason === "schema-missing")
            ) {
              return null;
            }
            throw error;
          }
          if (exact.sharing) {
            identities.set(database.path, exact.sharing.databaseIdentity);
          }
          assertCurrent();
          if (exact.sharing?.placeholders.length) {
            return null;
          }
          let entry = exact.entries[0]?.entry;
          if (!entry) {
            const read = await reader.readEntryResult({ scope });
            assertCurrent();
            if (!read.ok) {
              return null;
            }
            entry = read.value;
          }
          if (entry) {
            if (matched) {
              return null;
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
            const read = await reader!.readEntryResult({ scope });
            const assertFallbackCurrent = () => {
              assertCurrent();
              reader!.assertCurrent();
            };
            assertFallbackCurrent();
            if (!read.ok || !read.value) {
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
}
