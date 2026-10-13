import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { notifyListeners, registerListener } from "../../../src/shared/listeners.js";
import type { AgentsListResult } from "../api/types.ts";
import { fnv1aUtf16 } from "../lib/fnv1a.ts";
import type { SessionGroupSettings } from "../lib/sessions/custom-groups.ts";
import { getSafeLocalStorage } from "../local-storage.ts";

const BOOT_RECORD_PREFIX = "openclaw.control.bootRecord.v1:";
const BOOT_RECORD_MAX_BYTES = 64 * 1024;
const BOOT_RECORD_MAX_AGE = 30 * 24 * 60 * 60 * 1000;
let bootRecordGeneration = 0;
type BootRecordChange = {
  scope?: string;
  external?: true;
  replacement?: BootRecordOwner;
  retiredOwner?: BootRecordOwner;
};
const retirementListeners = new Set<(change: BootRecordChange) => void>();
export function subscribeBootRecordChanges(
  listener: (change: BootRecordChange) => void,
): () => void {
  return registerListener(retirementListeners, listener);
}

export type BootRecord = {
  version: 2;
  /** Server-issued storage identity, never a bearer or RPC authority. */
  recoveryScope?: string;
  authMethod: string;
  credential: string;
  savedAt: number;
  scope: string;
  profileId: string | null;
  agents: AgentsListResult;
  groups: SessionGroupSettings[];
  sectionOrder: string[];
};

function notifyBootRecordChange(change: BootRecordChange): void {
  notifyListeners(retirementListeners, change, (error) =>
    console.error("[boot-record] observer failed", error),
  );
}

export type BootRecordOwner =
  | { recoveryScope: string }
  | { recoveryScope?: undefined; authMethod: string; credential: string };

export function bootRecordOwner(
  record: Pick<BootRecord, "recoveryScope" | "authMethod" | "credential">,
): BootRecordOwner {
  return record.recoveryScope
    ? { recoveryScope: record.recoveryScope }
    : { authMethod: record.authMethod, credential: record.credential };
}

export function sameBootRecordOwner(
  left: BootRecordOwner | undefined,
  right: BootRecordOwner | undefined,
): boolean {
  if (!left || !right) {
    return false;
  }
  return left.recoveryScope !== undefined
    ? left.recoveryScope === right.recoveryScope
    : right.recoveryScope === undefined &&
        left.authMethod === right.authMethod &&
        left.credential === right.credential;
}

function credentialFingerprint(credential: string | null | undefined): string | null {
  const value = credential?.trim();
  return value ? fnv1aUtf16(value).toString(16) : null;
}

export function resolveBootRecordAuth(
  auth: { method?: string; deviceToken?: string; recoveryScope?: string } | undefined,
  token?: string,
): Pick<BootRecord, "authMethod" | "credential"> | null {
  // Bootstrap itself is single-use. The hello can issue the reusable device
  // grant that the browser client has stored before publishing this admission.
  const method = auth?.method === "bootstrap-token" ? "device-token" : auth?.method;
  if (
    auth?.recoveryScope?.trim() &&
    method &&
    ["trusted-proxy", "tailscale", "password"].includes(method)
  ) {
    return { authMethod: method, credential: "" };
  }
  if (method !== "token" && method !== "device-token") {
    return null;
  }
  const credential = credentialFingerprint(method === "token" ? token : auth?.deviceToken);
  return credential ? { authMethod: method, credential } : null;
}

function isBootRecord(value: unknown): value is BootRecord {
  if (!isRecord(value) || !isRecord(value.agents)) {
    return false;
  }
  const agents = value.agents;
  return (
    value.version === 2 &&
    (["token", "device-token"].includes(String(value.authMethod)) ||
      (["trusted-proxy", "tailscale", "password"].includes(String(value.authMethod)) &&
        typeof value.recoveryScope === "string" &&
        value.recoveryScope.length > 0)) &&
    (value.recoveryScope === undefined ||
      (typeof value.recoveryScope === "string" && value.recoveryScope.length > 0)) &&
    typeof value.credential === "string" &&
    typeof value.savedAt === "number" &&
    Number.isFinite(value.savedAt) &&
    value.savedAt >= 0 &&
    typeof value.scope === "string" &&
    (value.profileId === null || typeof value.profileId === "string") &&
    typeof agents.defaultId === "string" &&
    agents.defaultId.trim().length > 0 &&
    typeof agents.mainKey === "string" &&
    agents.mainKey.trim().length > 0 &&
    (agents.scope === "per-sender" || agents.scope === "global") &&
    Array.isArray(agents.agents) &&
    agents.agents.every((agent: unknown) => isRecord(agent) && typeof agent.id === "string") &&
    Array.isArray(value.groups) &&
    value.groups.every(
      (group: unknown) =>
        isRecord(group) && typeof group.name === "string" && typeof group.position === "number",
    ) &&
    Array.isArray(value.sectionOrder) &&
    value.sectionOrder.every((section: unknown) => typeof section === "string")
  );
}

function parseBootRecord(raw: string | null, scope: string | undefined): BootRecord | null {
  if (!raw || new TextEncoder().encode(raw).length > BOOT_RECORD_MAX_BYTES) {
    return null;
  }
  try {
    const record: unknown = JSON.parse(raw);
    return isBootRecord(record) && record.scope === scope ? record : null;
  } catch {
    return null;
  }
}

export function readBootRecord(
  scope: string,
  credentialForMethod: (method: string) => string | null | undefined,
): BootRecord | null {
  const storage = getSafeLocalStorage();
  const key = BOOT_RECORD_PREFIX + scope;
  try {
    const json = storage?.getItem(key);
    if (json == null) {
      return null;
    }
    const record = parseBootRecord(json, scope);
    if (record && Date.now() - record.savedAt <= BOOT_RECORD_MAX_AGE) {
      // A different document’s credential selection cannot retire this owner.
      // Only malformed/expired data is eviction; non-admission is a pure read.
      try {
        const credential = credentialForMethod(record.authMethod);
        const admitted = ["trusted-proxy", "tailscale", "password"].includes(record.authMethod)
          ? credential === ""
          : record.credential === credentialFingerprint(credential);
        return admitted ? record : null;
      } catch {
        return null;
      }
    }
  } catch {
    // Browser storage is optional; malformed records must never prevent startup.
  }
  try {
    storage?.removeItem(key);
  } catch {}
  return null;
}

/** Cancel an owned publication without deleting a peer’s persisted admission. */
export function retirePendingBootRecord(scope: string | undefined, owner: BootRecordOwner): void {
  if (
    pending &&
    pending.record.scope === scope &&
    sameBootRecordOwner(bootRecordOwner(pending.record), owner)
  ) {
    pending = undefined;
    clearTimeout(timer);
    timer = undefined;
  }
}

function removeOwnedBootRecord(scope: string | undefined, owner: BootRecordOwner): void {
  try {
    const storage = getSafeLocalStorage();
    const key = BOOT_RECORD_PREFIX + scope;
    const raw = storage?.getItem(key);
    const record: unknown = raw ? JSON.parse(raw) : null;
    if (
      isBootRecord(record) &&
      record.scope === scope &&
      sameBootRecordOwner(bootRecordOwner(record), owner)
    ) {
      storage?.removeItem(key);
    }
  } catch {}
}

export function clearBootRecords(scope?: string, owner?: BootRecordOwner): void {
  if (owner) {
    retirePendingBootRecord(scope, owner);
    removeOwnedBootRecord(scope, owner);
    notifyBootRecordChange({ scope, retiredOwner: owner });
    return;
  }
  bootRecordGeneration += 1;
  notifyBootRecordChange({ scope });
  try {
    const storage = getSafeLocalStorage();
    if (!storage) {
      return;
    }
    if (scope !== undefined) {
      storage.removeItem(BOOT_RECORD_PREFIX + scope);
      return;
    }
    for (let index = storage.length - 1; index >= 0; index -= 1) {
      const key = storage.key(index);
      if (key?.startsWith(BOOT_RECORD_PREFIX)) {
        storage.removeItem(key);
      }
    }
  } catch {}
}

/** One projection of the admitted boot record for local reads/writes only. */
export type OfflineStorageClient = {
  recoveryScope?: string;
  recoveryScopeReady?: boolean;
  offlineRecoveryScope?: string;
  offlineRecoveryRetired?: boolean;
};
const knownStorageScopes = new WeakMap<object, string>();
export function readOfflineStorageScope(host: {
  client?: OfflineStorageClient | null;
  connected?: boolean;
}): string | undefined {
  const client = host.client;
  if (!client || client.offlineRecoveryRetired || (host.connected && !client.recoveryScopeReady)) {
    return undefined;
  }
  if (client.recoveryScopeReady && client.recoveryScope) {
    knownStorageScopes.set(client, client.recoveryScope);
  }
  const remembered = knownStorageScopes.get(client);
  return (
    (client.recoveryScopeReady
      ? client.recoveryScope
      : (client.offlineRecoveryScope ??
        (remembered === client.recoveryScope ? remembered : undefined))
    )?.trim() || undefined
  );
}

let timer: ReturnType<typeof setTimeout> | undefined;
let pending: { record: BootRecord; generation: number } | undefined;

function flushBootRecord(): void {
  clearTimeout(timer);
  timer = undefined;
  const write = pending;
  pending = undefined;
  if (!write || write.generation !== bootRecordGeneration) {
    return;
  }
  const { record } = write;
  const storage = getSafeLocalStorage();
  const key = BOOT_RECORD_PREFIX + record.scope;
  try {
    const agents = {
      ...record.agents,
      agents: record.agents.agents.map((agent) => {
        const identity = agent.identity ? { ...agent.identity } : undefined;
        if (identity) {
          delete identity.avatar;
          delete identity.avatarUrl;
        }
        return { ...agent, identity };
      }),
    };
    const json = JSON.stringify({ ...record, agents });
    if (new TextEncoder().encode(json).length > BOOT_RECORD_MAX_BYTES) {
      removeOwnedBootRecord(record.scope, bootRecordOwner(record));
    } else {
      storage?.setItem(key, json);
      if (storage?.getItem(key) === json) {
        notifyBootRecordChange({ scope: record.scope, replacement: bootRecordOwner(record) });
      }
    }
  } catch {
    removeOwnedBootRecord(record.scope, bootRecordOwner(record));
  }
}

export function persistBootRecord(record: BootRecord): void {
  clearTimeout(timer);
  pending = { record, generation: bootRecordGeneration };
  timer = setTimeout(flushBootRecord, 500);
}

if (
  typeof window !== "undefined" &&
  typeof window.addEventListener === "function" &&
  typeof document !== "undefined" &&
  typeof document.addEventListener === "function"
) {
  window.addEventListener("storage", (event) => {
    if (event.key !== null && !event.key.startsWith(BOOT_RECORD_PREFIX)) {
      return;
    }
    const scope = event.key?.slice(BOOT_RECORD_PREFIX.length);
    const next = parseBootRecord(event.newValue, scope);
    const replacement =
      next && Date.now() - next.savedAt <= BOOT_RECORD_MAX_AGE ? bootRecordOwner(next) : undefined;
    const previous = event.newValue === null ? parseBootRecord(event.oldValue, scope) : null;
    const retiredOwner = previous ? bootRecordOwner(previous) : undefined;
    // Replacement data never admits an account. Each consumer compares its own
    // owner; same-account tabs keep their live connection and pending publication.
    if (
      (!scope || pending?.record.scope === scope) &&
      (!retiredOwner ||
        (pending && sameBootRecordOwner(retiredOwner, bootRecordOwner(pending.record)))) &&
      !sameBootRecordOwner(replacement, pending ? bootRecordOwner(pending.record) : undefined)
    ) {
      bootRecordGeneration += 1;
    }
    notifyBootRecordChange({ scope, external: true, replacement, retiredOwner });
  });
  window.addEventListener("pagehide", flushBootRecord);
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") {
      flushBootRecord();
    }
  });
}
