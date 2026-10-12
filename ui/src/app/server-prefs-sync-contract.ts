import type { GatewayBrowserClient } from "../api/gateway.ts";
import type { RuntimeConfigCapability } from "../lib/config/runtime-config-capability.ts";
import type { ServerUiPrefs, SyncedPrefKey } from "./server-prefs-state.ts";
import type { UiSettings } from "./settings-contract.ts";

// The eager owner and deferred operations share declarations without importing each other.
export type ServerUiPrefsWriter = Pick<
  RuntimeConfigCapability,
  "canPatch" | "runExternalMutation"
> & {
  readonly state: {
    readonly client: GatewayBrowserClient | null;
    readonly connected: boolean;
    readonly configSnapshot?: { readonly config?: unknown } | null;
  };
};
export type ServerUiPrefsCommit = { needsRefresh: boolean; retainedLocal?: boolean };
// Sole mutable sync owner. Config reconciliation and write operations borrow it when needed.
export type ServerUiPrefsSync = {
  applyingServerPrefs: boolean;
  pendingScope: string;
  pendingPrefs: ServerUiPrefs | null;
  pendingPersistedKeys: Set<string>;
  // The active pin operation alone can observe local successors; foreign adoption detaches it.
  composeSidebar: ((pending: ServerUiPrefs | null, next: ServerUiPrefs) => void) | null;
  pushWriter: ServerUiPrefsWriter | null;
  pushScope: string;
  pushClient: GatewayBrowserClient | null;
  pushProfileId: string | null;
  pushCanWrite: boolean;
  pushAfterCommit: ((commit: ServerUiPrefsCommit) => void) | undefined;
  pushDraining: boolean;
  drainRequested: boolean;
  pushEpoch: number;
  confirmedPrefsFallback: ConfirmedPrefsFallback | null;
  lastReconciledScope: string | null;
  lastReconciledConfigObject: unknown;
  preferenceWriteFailures: Map<
    string,
    Map<SyncedPrefKey, { value: unknown; error: string; retained: boolean }>
  >;
  writePendingStorage(prefs: ServerUiPrefs | null): void;
  recordPreferenceWriteFailures(
    scope: string,
    values: ServerUiPrefs,
    error: unknown,
    retained?: boolean,
  ): void;
  reconcilePersistedPendingPrefs(adoptKeys?: readonly SyncedPrefKey[]): void;
  cancelPendingKeys(scope: string, keys: readonly SyncedPrefKey[]): void;
  updateRetainedLocalKeys(scope: string, keys: readonly SyncedPrefKey[], retained: boolean): void;
  publishPreferenceWrites(): void;
  mergePendingIntoStorage(ackedBatch?: ServerUiPrefs): void;
  startPendingDrain(writer: ServerUiPrefsWriter): void;
  batchIsCurrent(batch: ServerUiPrefs): boolean;
  applyServerPrefsPatch(patch: Partial<UiSettings>): void;
};

export type ConfirmedPrefsFallback = {
  scope: string;
  raw: string | null;
  prefs: ServerUiPrefs | null;
  dirty: boolean;
};
