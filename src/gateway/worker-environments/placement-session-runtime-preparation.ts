import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import { retainPreparedSessionEntryPredicate } from "../../config/sessions/session-accessor.sqlite-entry-cache-publication-state.js";
import { captureSessionEntryMetadataRead } from "../../config/sessions/session-entry-source-authority.js";
import type { SessionEntry } from "../../config/sessions/types.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { isIncognitoSessionKey, parseAgentSessionKey } from "../../routing/session-key.js";
import {
  isSessionStoreTopologyChange,
  sessionChanges,
  sessionChangeScopeAffectsStoredRows,
} from "../../sessions/session-row-changes.js";
import { registerOpenClawAgentDatabaseAsyncResource } from "../../state/openclaw-agent-db-resources.js";
import { captureSessionMutationRouting } from "../session-sharing-preparation.js";
import { createGatewaySessionEntryReader } from "../session-utils-store-lineage.js";
import { resolveGatewaySessionStoreTargetWithStore } from "../session-utils-store-lookup.js";
import type { GatewaySessionStoreTargetWithStore } from "../session-utils-store.types.js";
import {
  readWorkerPlacementModelSource,
  resolveWorkerPlacementSessionRuntime,
  resolveWorkerPlacementSessionRuntimeAsync,
} from "./placement-session-runtime.js";

const modelFields = [
  "sessionId",
  "lifecycleRevision",
  "providerOverride",
  "modelOverride",
  "modelOverrideSource",
  "modelOverrideRouteResolution",
  "modelOverrideFallbackOriginProvider",
  "modelOverrideFallbackOriginModel",
] as const satisfies readonly (keyof SessionEntry)[];

function matchesFields(
  before: SessionEntry | undefined,
  after: SessionEntry | undefined,
  fields: readonly (keyof SessionEntry)[],
) {
  return before && after
    ? fields.every((field) => isDeepStrictEqual(before[field], after[field]))
    : before === after;
}

/** Retain inherited model facts while the final resolver still asks the live harness owner. */
export async function prepareWorkerPlacementSessionRuntime(params: {
  cfg: OpenClawConfig;
  entry: SessionEntry;
  agentId: string;
  sessionKey: string;
  initialTarget?: GatewaySessionStoreTargetWithStore;
}) {
  let active = true;
  let invalidated = false;
  const releases: Array<() => void> = [];
  const predicates = new Map<string, ReturnType<typeof retainPreparedSessionEntryPredicate>>();
  const sources = new Map<string, Set<string>>();
  const parents = new Map<string, () => SessionEntry | undefined>();
  const release = () => {
    if (!active) {
      return;
    }
    active = false;
    for (const stop of releases.splice(0).toReversed()) {
      stop();
    }
  };
  const assertCurrent = () => {
    if (!active || invalidated || [...predicates.values()].some((read) => !read.isCurrent())) {
      throw new Error("Session model inheritance changed during worker placement; retry.");
    }
  };
  const retainTarget = (target: GatewaySessionStoreTargetWithStore) => {
    for (const key of target.storeKeys) {
      if (!sources.has(key)) {
        sources.set(key, new Set());
      }
    }
    const captured =
      target.capturedReadSources ?? (target.capturedReadSource ? [target.capturedReadSource] : []);
    for (const source of captured) {
      if (typeof source.databaseIdentity !== "string") {
        continue;
      }
      const sourcePath = path.resolve(source.path);
      const selected = source.path === target.readSource?.path;
      for (const key of target.storeKeys) {
        sources.get(key)!.add(sourcePath);
        const identity = `${source.databaseIdentity}\0${key}`;
        if (predicates.has(identity)) {
          continue;
        }
        const predicate = retainPreparedSessionEntryPredicate({
          databaseIdentity: `file:${source.databaseIdentity}`,
          sessionKey: key,
          entry: selected ? target.store[key] : undefined,
          matches: (before, after) => matchesFields(before, after, modelFields),
        });
        predicates.set(identity, predicate);
        releases.push(predicate.release);
      }
      releases.push(
        registerOpenClawAgentDatabaseAsyncResource({
          agentId: source.agentId,
          path: source.path,
          revoke: () => {
            invalidated = true;
          },
          close: async () => {
            invalidated = true;
          },
        }),
      );
    }
  };
  if (!isIncognitoSessionKey(params.sessionKey)) {
    releases.push(
      sessionChanges.subscribeFacts((change) => {
        if (
          isSessionStoreTopologyChange(change) ||
          ("all" in change && sessionChangeScopeAffectsStoredRows(change))
        ) {
          invalidated = true;
        } else if (
          "sessionKey" in change &&
          sources.has(change.sessionKey) &&
          (!change.storePath ||
            !sources.get(change.sessionKey)!.has(path.resolve(change.storePath)))
        ) {
          // A formerly absent physical source can appear without a retained row predicate.
          invalidated = true;
        }
      }),
    );
  }
  try {
    await resolveWorkerPlacementSessionRuntimeAsync({
      ...params,
      assertCurrent,
      readSourceEntry: async (key) => {
        const metadata = captureSessionEntryMetadataRead({
          sessionKey: key,
          agentId: params.agentId,
        });
        if (metadata) {
          parents.set(key, () => metadata.readCurrent());
          return metadata.readCurrent();
        }
        const entry = await readWorkerPlacementModelSource(
          { ...params, assertCurrent, onSelected: retainTarget },
          key,
        );
        parents.set(key, () => entry);
        return entry;
      },
    });
    const assertRouting = parents.size
      ? captureSessionMutationRouting(
          params.cfg,
          undefined,
          [...parents.keys()].map((sessionKey) => ({
            sessionKey,
            agentId: parseAgentSessionKey(sessionKey)?.agentId ?? params.agentId,
            preserveQualifiedAddress: true,
          })),
        )
      : undefined;
    assertCurrent();
    return {
      [Symbol.dispose]: release,
      read(currentCfg: OpenClawConfig, currentEntry: SessionEntry): string {
        assertCurrent();
        assertRouting?.(currentCfg);
        return resolveWorkerPlacementSessionRuntime({
          cfg: currentCfg,
          entry: currentEntry,
          agentId: params.agentId,
          sessionKey: params.sessionKey,
          readSourceEntry: (key) => {
            if (isIncognitoSessionKey(params.sessionKey)) {
              const metadata = captureSessionEntryMetadataRead({
                sessionKey: key,
                agentId: params.agentId,
              });
              if (metadata) {
                return metadata.readCurrent();
              }
              // The unbound native incognito owner retains its live final-effect read.
              const target = resolveGatewaySessionStoreTargetWithStore({
                cfg: currentCfg,
                key: params.sessionKey,
                agentId: params.agentId,
                preserveQualifiedAddress: true,
                clone: false,
                readOnly: true,
                exactRead: true,
              });
              return createGatewaySessionEntryReader({ ...target, cfg: currentCfg })(key);
            }
            const read = parents.get(key);
            if (!read) {
              throw new Error("Session model inheritance changed during worker placement; retry.");
            }
            return read();
          },
        });
      },
    };
  } catch (error) {
    release();
    throw error;
  }
}
