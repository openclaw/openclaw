import { statSync } from "node:fs";
import path from "node:path";
import {
  captureSessionStoreReadCandidates,
  prepareSessionStoreTargetInventory,
} from "../config/sessions/session-store-target-inventory.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { readDatabasePathIdentitySync } from "../infra/sqlite-worker-identity.js";
import { normalizeAgentId, parseAgentSessionKey } from "../routing/session-key.js";
import type { SessionIdentityMutation } from "../sessions/session-lifecycle-events.js";
import * as records from "./session-row-projection-record.js";
import { resolveStoredSessionKeyForAgentStore } from "./session-store-key.js";

type ObservationQuery = { agentId: string; storePath?: string } & (
  | { key: string; sessionId?: never }
  | { sessionId: string; key?: never }
);
type PhysicalCandidate = { path: string; identity: string; birthtime: string };

function samePhysicalFile(candidate: PhysicalCandidate, pathname = candidate.path): boolean {
  try {
    const file = statSync(pathname, { bigint: true, throwIfNoEntry: false });
    return Boolean(
      file?.isFile() &&
      `${file.dev}:${file.ino}` === candidate.identity &&
      file.birthtimeNs.toString() === candidate.birthtime,
    );
  } catch {
    return false;
  }
}

/** Pending events observe mutations in the same owner that renews published row generations. */
export function createSessionRowGenerationObservations(owner: {
  config: () => OpenClawConfig;
  env: NodeJS.ProcessEnv;
  isActive: () => boolean;
  stores: () => ReadonlyMap<string, records.SessionRowStore>;
  isCurrent: (row: records.Row) => boolean;
  matching: (query: records.Query) => records.Row[];
  markRelated: (row: records.Row) => void;
  put: (row: records.Row) => void;
  remove: (id: string) => void;
  dirty: Set<string>;
  mark: (change: { agentId: string; sessionKey: string }) => void;
  ensureMaterialized: () => Promise<void>;
}) {
  const observations = new Set<{
    changed: (mutation: SessionIdentityMutation) => boolean;
    dispose: () => void;
  }>();
  return {
    invalidate(this: void) {
      for (const observation of observations) {
        observation.dispose();
      }
    },
    observeGeneration(this: void, query: ObservationQuery) {
      if (!owner.isActive()) {
        return { isCurrent: () => false, dispose: () => {} };
      }
      const config = owner.config();
      const agentId = normalizeAgentId(query.agentId);
      const sessionId = query.sessionId;
      const canonicalKey = (sessionKey: string) =>
        resolveStoredSessionKeyForAgentStore({ cfg: config, agentId, sessionKey });
      const key = query.key === undefined ? undefined : canonicalKey(query.key);
      const sources = [...owner.stores().values()];
      const paths = query.storePath
        ? [query.storePath]
        : sources
            .filter((source) => source.agentId === agentId || source.target.agentId === agentId)
            .map((source) => source.target.storePath);
      const candidates = new Map<string, PhysicalCandidate>();
      try {
        const captured = [
          ...[...new Set(paths)].flatMap(captureSessionStoreReadCandidates),
          ...(query.storePath
            ? []
            : prepareSessionStoreTargetInventory(config, [agentId], owner.env).candidates),
        ];
        for (const candidate of captured) {
          // An absent file or an unenumerated sibling cannot witness an original generation.
          if (candidate.scope) {
            continue;
          }
          const cachedSource = sources.find(
            (source) =>
              path.resolve(source.target.storePath) === candidate.path ||
              path.resolve(source.filename) === candidate.physicalPath,
          );
          if (cachedSource) {
            if (typeof cachedSource.identity === "string" && cachedSource.birthtime !== undefined) {
              candidates.set(candidate.path, {
                path: candidate.path,
                identity: cachedSource.identity,
                birthtime: cachedSource.birthtime,
              });
            }
            continue;
          }
          const identity = readDatabasePathIdentitySync(candidate.path);
          const file = statSync(candidate.path, { bigint: true, throwIfNoEntry: false });
          if (file?.isFile() && identity.key === `file:${file.dev}:${file.ino}`) {
            candidates.set(candidate.path, {
              path: candidate.path,
              identity: `${file.dev}:${file.ino}`,
              birthtime: file.birthtimeNs.toString(),
            });
          }
        }
      } catch {
        // A changed or uninspectable source cannot establish custody for a later row.
        candidates.clear();
      }
      let active = owner.isActive() && candidates.size > 0;
      const observation = {
        changed(mutation: SessionIdentityMutation) {
          if (
            ![...candidates.values()].some(
              (source) => source.identity === mutation.databaseIdentity,
            )
          ) {
            return false;
          }
          const targets = [mutation.previous, ...("current" in mutation ? [mutation.current] : [])];
          return targets.some((target) => {
            const keys = target.sessionKeys.filter(
              (sessionKey) =>
                normalizeAgentId(parseAgentSessionKey(sessionKey)?.agentId ?? mutation.agentId) ===
                agentId,
            );
            // ID-only markers can name a physical shared owner before logical ownership is known.
            return key === undefined
              ? target.sessionId === sessionId
              : keys.some((sessionKey) => canonicalKey(sessionKey) === key);
          });
        },
        dispose(this: void) {
          active = false;
          observations.delete(observation);
        },
      };
      if (active) {
        observations.add(observation);
      }
      return {
        isCurrent(row: records.Row) {
          if (
            !active ||
            !owner.isActive() ||
            owner.config() !== config ||
            (row.agentId !== agentId &&
              (key !== undefined || row.storeTarget.agentId !== agentId)) ||
            !owner.isCurrent(row) ||
            (key === undefined ? row.entry?.sessionId !== sessionId : canonicalKey(row.key) !== key)
          ) {
            return false;
          }
          const source = owner.stores().get(row.storeTarget.storePath);
          return Boolean(
            source &&
            [...candidates.values()].some(
              (candidate) =>
                source.identity === candidate.identity &&
                source.birthtime === candidate.birthtime &&
                samePhysicalFile(candidate) &&
                samePhysicalFile(candidate, row.storeTarget.storePath),
            ),
          );
        },
        dispose: observation.dispose,
      };
    },
    mutate(this: void, mutation: SessionIdentityMutation) {
      for (const observation of observations) {
        if (observation.changed(mutation)) {
          observation.dispose();
        }
      }
      for (const key of mutation.previous.sessionKeys) {
        for (const row of owner.matching({ key, agentId: mutation.agentId })) {
          if (
            owner.stores().get(row.storeTarget.storePath)?.identity !== mutation.databaseIdentity
          ) {
            continue;
          }
          if (mutation.previous.sessionId && row.entry?.sessionId !== mutation.previous.sessionId) {
            continue;
          }
          owner.markRelated(row);
          if ("current" in mutation && mutation.current.sessionKeys.includes(row.key)) {
            owner.put(records.renewGeneration(row));
            owner.dirty.add(records.identity(row));
          } else {
            owner.remove(records.identity(row));
          }
        }
      }
      if ("current" in mutation) {
        for (const sessionKey of mutation.current.sessionKeys) {
          owner.mark({ agentId: mutation.agentId, sessionKey });
        }
      } else {
        void owner.ensureMaterialized().catch(() => {});
      }
    },
  };
}
