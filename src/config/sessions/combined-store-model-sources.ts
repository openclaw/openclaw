import { selectStoredSessionLineage } from "../../gateway/session-store-key.js";
import type { GatewaySessionModelSource } from "../../gateway/session-utils-contracts.js";
import { createGatewaySessionLineageReader } from "../../gateway/session-utils-store-lookup.js";
import { normalizeAgentId, parseAgentSessionKey } from "../../routing/session-key.js";
import { readAgentDatabaseAdmissionRefusal } from "../../state/agent-database-admission.js";
import type { OpenClawConfig } from "../types.openclaw.js";
import { storeTargetKey } from "./combined-store-paths.js";
import type { SessionStoreTarget } from "./targets.js";
import type { SessionEntry } from "./types.js";

// Model sources retain stored lineage; combined rows may project aliases for display.
export type GatewayStoredSessionTarget = GatewaySessionModelSource & {
  agentId: string;
  /** Exact stored key when a list uses an internal key to retain sentinel owners. */
  storeKey?: string;
  storeTarget: SessionStoreTarget;
  resolveSourceKey: (key: string) => string;
};

export type GatewayStoredSessionTargets = ReadonlyMap<string, GatewayStoredSessionTarget>;

export function createSessionModelSources(
  cfg: OpenClawConfig,
  diagnostics: string[],
  preparedAgentIds?: ReadonlySet<string>,
) {
  const physicalStores = new Map<
    string,
    {
      entries: Record<string, SessionEntry>;
      readers: Map<
        string,
        Pick<GatewayStoredSessionTarget, "readSourceEntry" | "resolveSourceKey">
      >;
    }
  >();
  const logicalEntries = new Map<string, SessionEntry | undefined>();
  const logicalKey = (agentId: string, key: string) => `${normalizeAgentId(agentId)}\0${key}`;
  return {
    prepareStore(target: SessionStoreTarget) {
      const physicalKey = storeTargetKey(target);
      let physical = physicalStores.get(physicalKey);
      if (!physical) {
        physical = { entries: {}, readers: new Map() };
        physicalStores.set(physicalKey, physical);
      }
      const { entries: store, readers } = physical;
      return (logicalAgentId: string, storedKey: string, entry: SessionEntry) => {
        store[storedKey] = entry;
        const identity = logicalKey(logicalAgentId, storedKey);
        // Preserve target-order selection within an owner, including hidden sentinels.
        if (!logicalEntries.has(identity)) {
          logicalEntries.set(identity, entry);
        }
        let read = readers.get(logicalAgentId);
        if (!read) {
          const readQualifiedParent = createGatewaySessionLineageReader(cfg);
          // Capture the chosen fallback separately: it is not proof that the literal row exists.
          const selectedParents = new Map<
            string,
            { key: string; value: SessionEntry | undefined }
          >();
          const select = (parentKey: string) => {
            if (parentKey === "global" || parentKey === "unknown") {
              return { key: parentKey, value: store[parentKey] };
            }
            // Stored qualified lineage retains its owner before a main alias collapses.
            const parsed = parseAgentSessionKey(parentKey);
            const agentId = normalizeAgentId(parsed?.agentId ?? logicalAgentId);
            const refusal = readAgentDatabaseAdmissionRefusal(agentId);
            if (refusal) {
              const message = `${refusal.reason}\n${refusal.repairHint}`;
              if (!diagnostics.includes(message)) {
                diagnostics.push(message);
              }
              return { key: parentKey, value: undefined };
            }
            const captured = selectedParents.get(parentKey);
            if (captured) {
              return captured;
            }
            const selected = selectStoredSessionLineage({
              cfg,
              agentId,
              sessionKey: parentKey,
              read(owner, key) {
                const parentIdentity = logicalKey(owner, key);
                // Prepared inventories prove absence; only missing owners need exact reads.
                if (
                  parsed &&
                  preparedAgentIds &&
                  !preparedAgentIds.has(owner) &&
                  !logicalEntries.has(parentIdentity)
                ) {
                  logicalEntries.set(parentIdentity, readQualifiedParent.readStored(owner, key));
                }
                return logicalEntries.get(parentIdentity);
              },
              readAlias(owner, key) {
                // Missing retired-default parents retain the shipped replacement-owner lookup.
                return parsed && preparedAgentIds && !preparedAgentIds.has(owner)
                  ? readQualifiedParent.readAlias(parentKey, logicalAgentId)
                  : logicalEntries.get(logicalKey(owner, key));
              },
            });
            selectedParents.set(parentKey, selected);
            return selected;
          };
          read = {
            readSourceEntry: (key) => select(key).value,
            resolveSourceKey: (key) => select(key).key,
          };
          readers.set(logicalAgentId, read);
        }
        return read;
      };
    },
    remove(target: GatewayStoredSessionTarget, key: string) {
      const store = physicalStores.get(storeTargetKey(target.storeTarget));
      if (store) {
        delete store.entries[key];
      }
      logicalEntries.delete(logicalKey(target.agentId, key));
    },
  };
}
