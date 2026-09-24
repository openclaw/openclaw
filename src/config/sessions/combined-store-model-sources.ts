import { resolveStoredSessionKeyForAgentStore } from "../../gateway/session-store-key.js";
import type { GatewaySessionModelSource } from "../../gateway/session-utils-contracts.js";
import { createGatewaySessionEntryReader } from "../../gateway/session-utils-store-lookup.js";
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
      readers: Map<string, GatewaySessionModelSource["readSourceEntry"]>;
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
      return (
        logicalAgentId: string,
        key: string,
        entry: SessionEntry,
      ): GatewaySessionModelSource["readSourceEntry"] => {
        store[key] = entry;
        const identity = logicalKey(logicalAgentId, key);
        // Preserve target-order selection within an owner, including hidden sentinels.
        if (!logicalEntries.has(identity)) {
          logicalEntries.set(identity, entry);
        }
        let read = readers.get(logicalAgentId);
        if (!read) {
          const readQualifiedParent = createGatewaySessionEntryReader({
            cfg,
            agentId: logicalAgentId,
            store,
          });
          read = (parentKey) => {
            if (parentKey === "global" || parentKey === "unknown") {
              return store[parentKey];
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
              return undefined;
            }
            const canonicalKey = resolveStoredSessionKeyForAgentStore({
              cfg,
              agentId,
              sessionKey: parentKey,
            });
            const parentIdentity = logicalKey(agentId, canonicalKey);
            // Only unprepared qualified owners need an exact read. Cache absence too,
            // without treating one parent read as a complete view of that owner's store.
            if (
              parsed &&
              preparedAgentIds &&
              !preparedAgentIds.has(agentId) &&
              !logicalEntries.has(parentIdentity)
            ) {
              logicalEntries.set(parentIdentity, readQualifiedParent(parentKey));
            }
            return logicalEntries.get(parentIdentity);
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
