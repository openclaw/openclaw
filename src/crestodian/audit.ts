import { randomUUID } from "node:crypto";
import {
  createCorePluginStateKeyedStore,
  type PluginStateEntry,
} from "../plugin-state/plugin-state-store.js";

export type CrestodianAuditEntry = {
  timestamp: string;
  operation: string;
  summary: string;
  configPath?: string;
  configHashBefore?: string | null;
  configHashAfter?: string | null;
  details?: Record<string, unknown>;
};

export const CRESTODIAN_AUDIT_OWNER_ID = "core:crestodian";
export const CRESTODIAN_AUDIT_NAMESPACE = "audit";
export const CRESTODIAN_AUDIT_MAX_ENTRIES = 50_000;

const crestodianAuditStore = createCorePluginStateKeyedStore<CrestodianAuditEntry>({
  ownerId: CRESTODIAN_AUDIT_OWNER_ID,
  namespace: CRESTODIAN_AUDIT_NAMESPACE,
  maxEntries: CRESTODIAN_AUDIT_MAX_ENTRIES,
});

function resolveCrestodianAuditKey(entry: CrestodianAuditEntry): string {
  const suffix = randomUUID();
  return `${entry.timestamp}:${suffix}`;
}

export async function appendCrestodianAuditEntry(
  entry: Omit<CrestodianAuditEntry, "timestamp">,
): Promise<string> {
  const record = {
    timestamp: new Date().toISOString(),
    ...entry,
  } satisfies CrestodianAuditEntry;
  await crestodianAuditStore.register(resolveCrestodianAuditKey(record), record);
  return `${CRESTODIAN_AUDIT_OWNER_ID}/${CRESTODIAN_AUDIT_NAMESPACE}`;
}

export async function listCrestodianAuditEntriesForTests(): Promise<
  PluginStateEntry<CrestodianAuditEntry>[]
> {
  return await crestodianAuditStore.entries();
}
