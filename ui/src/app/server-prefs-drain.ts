import { sleepWithAbort } from "@openclaw/retry";
import type { ConfigPatchAck } from "../lib/config/config-gateway-operations.ts";
import { readConfirmedPrefs, publishConfirmedPrefs } from "./server-prefs-confirmation.ts";
import { foldSidebarEntriesBase, hasSidebarOrderIntent } from "./server-prefs-intent.ts";
import {
  refreshProfileAppearancePrefs,
  resolveProfileAppearancePrefs,
} from "./server-prefs-reconcile.ts";
import {
  SYNCED_PREF_KEYS,
  SYNCED_PREFS,
  prefValuesEqual,
  clearSidebarEntriesMetadata,
  type ServerUiPrefs,
  type SyncedPrefKey,
} from "./server-prefs-state.ts";
import type { ServerUiPrefsSync, ServerUiPrefsWriter } from "./server-prefs-sync-contract.ts";
import {
  selectProfileUiPrefs,
  removePendingUiPrefsBatch,
  serverUiPrefsCommittedSnapshot,
} from "./server-prefs-write-batch.ts";
import type { UiSettings } from "./settings-contract.ts";
import { invalidateUserPreferences } from "./user-prefs-cache.ts";

type DrainOwner = {
  scheduleConflictRedrain(writer: ServerUiPrefsWriter, epoch: number): void;
  reconcilePersistedPendingPrefs(): void;
  cancelPendingKeys(scope: string, keys: readonly SyncedPrefKey[]): void;
  updateRetainedLocalKeys(scope: string, keys: readonly SyncedPrefKey[], retained: boolean): void;
  batchIsCurrent(batch: ServerUiPrefs): boolean;
  applyServerPrefsPatch(patch: Partial<UiSettings>): void;
  mergePendingIntoStorage(batch?: ServerUiPrefs): void;
  clearConflictRedrain(): void;
};

// Operation-only code: the synchronous preference owner retains its outbox and
// all generation/authority facts, exposed live across every awaited boundary.
export async function drainPendingPrefs(
  writer: ServerUiPrefsWriter,
  epoch: number,
  sync: ServerUiPrefsSync,
  owner: DrainOwner,
): Promise<void> {
  const isCurrent = () => sync.pushWriter === writer && sync.pushEpoch === epoch;
  while (sync.pendingPrefs) {
    if (!isCurrent()) {
      return;
    }
    owner.reconcilePersistedPendingPrefs();
    if (!sync.pendingPrefs) {
      return;
    }
    const localOnlyKeys = SYNCED_PREF_KEYS.filter(
      (key) =>
        sync.pendingPrefs?.[key] !== undefined &&
        (SYNCED_PREFS[key].configSync === false ||
          (key === "theme" &&
            typeof sync.pendingPrefs.theme === "string" &&
            sync.pendingPrefs.theme.includes("/"))) &&
        !(sync.pushProfileId && sync.pushCanWrite),
    );
    if (localOnlyKeys.length) {
      if (!writer.state.connected) {
        return;
      }
      // Profile-only preferences must never fall through to config.patch,
      // including intent queued before this connection's identity was known.
      owner.cancelPendingKeys(sync.pendingScope, localOnlyKeys);
      owner.updateRetainedLocalKeys(sync.pendingScope, localOnlyKeys, true);
      sync.pushAfterCommit?.({ needsRefresh: false, retainedLocal: true });
      continue;
    }
    if (sync.pushProfileId && sync.pendingPrefs.theme === "custom") {
      // Offline-queued custom theme reaching a profile connection: browser-local
      // by contract, so retain it here instead of syncing it to the profile.
      owner.cancelPendingKeys(sync.pendingScope, ["theme"]);
      owner.updateRetainedLocalKeys(sync.pendingScope, ["theme"], true);
      continue;
    }
    const profileBatch =
      sync.pushProfileId && sync.pushCanWrite ? selectProfileUiPrefs(sync.pendingPrefs) : {};
    const useProfile = Object.keys(profileBatch).length > 0;
    const batch = useProfile ? profileBatch : { ...sync.pendingPrefs };
    const afterCommit = sync.pushAfterCommit;
    const capturedClient = writer.state.client;
    const profileId = sync.pushProfileId;
    const navigationReceipt =
      batch.sidebarEntries !== undefined || batch.navigationScope !== undefined;
    // Until this exact write is acknowledged, storage must retain the aggregate
    // intent for unknown-ack reloads. Only locally composed successors may then
    // observe its additions; remote adoption or an independent edit detaches it.
    let acknowledgedBase = batch.sidebarEntries;
    let composed = false;
    let reordered = false;
    const compose: ServerUiPrefsSync["composeSidebar"] = (pending, next) => {
      if (!next.sidebarEntries) {
        return;
      }
      if (
        !pending?.sidebarEntries ||
        !prefValuesEqual(next.sidebarEntriesBase, pending.sidebarEntries)
      ) {
        sync.composeSidebar = null;
        return;
      }
      acknowledgedBase = foldSidebarEntriesBase(
        acknowledgedBase!,
        pending.sidebarEntries,
        next.sidebarEntries,
      );
      composed = true;
      reordered ||= hasSidebarOrderIntent(next);
    };
    if (acknowledgedBase) {
      sync.composeSidebar = compose;
    }
    try {
      for (let attempt = 0; attempt < 2; attempt += 1) {
        if (!isCurrent()) {
          return;
        }
        if (useProfile && writer.state.client) {
          invalidateUserPreferences(writer.state.client);
        }
        let lastSeenAtDispatch: ServerUiPrefs = {};
        const result = useProfile
          ? await import("./server-prefs-profile-runtime.ts").then(
              ({ writeProfileAppearancePrefs }) =>
                writeProfileAppearancePrefs(
                  writer.state.client,
                  batch,
                  () => {
                    if (
                      !isCurrent() ||
                      writer.state.client !== capturedClient ||
                      !writer.state.connected ||
                      !sync.pushCanWrite
                    ) {
                      return false;
                    }
                    owner.reconcilePersistedPendingPrefs();
                    if (owner.batchIsCurrent(batch)) {
                      if (navigationReceipt) {
                        lastSeenAtDispatch = readConfirmedPrefs(sync, sync.pendingScope) ?? {};
                      }
                      return true;
                    }
                    sync.drainRequested = Boolean(sync.pendingPrefs);
                    return false;
                  },
                  profileId,
                ),
            )
          : await writer.runExternalMutation(
              (client) =>
                // ui.prefs is a deliberately narrow hashless LWW surface enforced by
                // hasHashlessPatchLwwStructure in the gateway. Serialization still
                // matters: a pending whole-config save must commit before this merge.
                client.request<ConfigPatchAck>("config.patch", {
                  raw: JSON.stringify({ ui: { prefs: batch } }),
                  note: "control-ui prefs sync",
                }),
              {
                waitForWritesResumed: true,
                configWriteAck: (ack) => ack,
                canDispatch: () => {
                  if (
                    !isCurrent() ||
                    writer.state.client !== capturedClient ||
                    writer.canPatch === false
                  ) {
                    return false;
                  }
                  owner.reconcilePersistedPendingPrefs();
                  if (owner.batchIsCurrent(batch)) {
                    return true;
                  }
                  sync.drainRequested = Boolean(sync.pendingPrefs);
                  return false;
                },
                dispatchError: "Access changed before preferences could sync.",
              },
            );
        if (!isCurrent()) {
          return;
        }
        owner.reconcilePersistedPendingPrefs();
        const dispatchedBatch = "batch" in result ? result.batch : batch;
        // RPC sub-batches omit browser metadata; acknowledge the complete original intent.
        const acknowledgedBatch = Object.hasOwn(dispatchedBatch, "sidebarEntries")
          ? {
              ...dispatchedBatch,
              sidebarEntriesBase: batch.sidebarEntriesBase,
              sidebarEntriesOrder: batch.sidebarEntriesOrder,
            }
          : dispatchedBatch;
        if (result.ok) {
          const committedBatch =
            "committedBatch" in result
              ? (result.committedBatch ?? dispatchedBatch)
              : dispatchedBatch;
          let lastSeen = readConfirmedPrefs(sync, sync.pendingScope) ?? {};
          if (
            navigationReceipt &&
            capturedClient &&
            writer.state.client === capturedClient &&
            writer.state.connected &&
            sync.pushCanWrite &&
            profileId &&
            (["sidebarEntries", "navigationScope"] as const).some(
              (key) =>
                Object.hasOwn(committedBatch, key) &&
                sync.pendingPrefs &&
                Object.hasOwn(sync.pendingPrefs, key) &&
                lastSeen.navigationConfirmation?.[key] !==
                  lastSeenAtDispatch.navigationConfirmation?.[key] &&
                !prefValuesEqual(lastSeen[key], committedBatch[key]),
            )
          ) {
            // users.prefs has no server revision: an identical read before this commit
            // and an ABA read after it have indistinguishable receipts. Only this raced,
            // still-owned ACK needs a fresh read; ordinary/settled ACKs never reread.
            const beforeRead = lastSeen.navigationConfirmation;
            const configObject = writer.state.configSnapshot?.config;
            invalidateUserPreferences(capturedClient);
            try {
              await refreshProfileAppearancePrefs({
                client: capturedClient,
                profileId,
                scope: capturedClient.gatewayUrl,
                configObject,
                onApplied: () => undefined,
                isCurrent: () => {
                  if (
                    !isCurrent() ||
                    writer.state.client !== capturedClient ||
                    !writer.state.connected ||
                    !sync.pushCanWrite ||
                    writer.state.configSnapshot?.config !== configObject
                  ) {
                    return false;
                  }
                  const confirmation = readConfirmedPrefs(
                    sync,
                    sync.pendingScope,
                  )?.navigationConfirmation;
                  return (["sidebarEntries", "navigationScope"] as const).every(
                    (key) => confirmation?.[key] === beforeRead?.[key],
                  );
                },
              });
            } catch {
              // A failed observation cannot replace the most recent confirmed snapshot.
            }
            if (!isCurrent() || writer.state.client !== capturedClient) {
              return;
            }
            owner.reconcilePersistedPendingPrefs();
            lastSeen = readConfirmedPrefs(sync, sync.pendingScope) ?? {};
          }
          const profilePrefs = useProfile
            ? resolveProfileAppearancePrefs(
                writer.state.client?.gatewayUrl ?? "",
                sync.pushProfileId,
              )
            : null;
          const publication = { ...committedBatch };
          let superseded = false;
          const latestNavigation: Partial<Pick<UiSettings, "sidebarEntries" | "navigationScope">> =
            {};
          if (navigationReceipt) {
            for (const key of ["sidebarEntries", "navigationScope"] as const) {
              // Shared lastSeen is already-confirmed profile-only navigation. Keep the
              // local read cache aligned so a later reconcile cannot roll it backward.
              const confirmed = SYNCED_PREFS[key].extract(lastSeen[key]);
              if (profilePrefs && confirmed !== undefined) {
                Object.assign(profilePrefs, { [key]: confirmed });
              }
              if (!Object.hasOwn(publication, key)) {
                continue;
              }
              const held = sync.pendingPrefs && Object.hasOwn(sync.pendingPrefs, key);
              const newer =
                (lastSeen.navigationConfirmation?.[key] !==
                  lastSeenAtDispatch.navigationConfirmation?.[key] ||
                  !prefValuesEqual(lastSeen[key], lastSeenAtDispatch[key])) &&
                !prefValuesEqual(lastSeen[key], committedBatch[key]);
              if (!held || newer) {
                // Clearing an outbox may mean a sibling settled or the user cancelled,
                // not permission for this older receipt to publish its committed value.
                delete publication[key];
                superseded = true;
                if (held && newer && confirmed !== undefined) {
                  Object.assign(latestNavigation, { [key]: confirmed });
                }
              }
            }
          }
          if (
            composed &&
            sync.composeSidebar === compose &&
            sync.pendingPrefs?.sidebarEntries &&
            acknowledgedBatch.sidebarEntries
          ) {
            sync.pendingPrefs.sidebarEntriesBase = acknowledgedBase!;
            sync.pendingPrefs.sidebarEntriesOrder = reordered || undefined;
            // A remove/readd can equal the original pair but is still newer intent.
            delete acknowledgedBatch.sidebarEntries;
            clearSidebarEntriesMetadata(acknowledgedBatch);
          }
          sync.pendingPrefs = removePendingUiPrefsBatch(
            sync.pendingPrefs,
            acknowledgedBatch,
            sync.pendingPersistedKeys,
          );
          const nextLastSeen = serverUiPrefsCommittedSnapshot(
            lastSeen,
            publication,
            profilePrefs,
            writer.state.configSnapshot?.config,
          );
          if (useProfile && !superseded) {
            sync.lastReconciledConfigObject = null;
          }
          if (publication.sidebarEntries) {
            latestNavigation.sidebarEntries = publication.sidebarEntries;
          }
          for (const key of ["sidebarEntries", "navigationScope"] as const) {
            if (sync.pendingPrefs && Object.hasOwn(sync.pendingPrefs, key)) {
              delete latestNavigation[key];
            }
          }
          if (Object.keys(latestNavigation).length) {
            owner.applyServerPrefsPatch(latestNavigation);
          }
          if (Object.keys(publication).length) {
            publishConfirmedPrefs(
              sync,
              sync.pendingScope,
              nextLastSeen,
              SYNCED_PREF_KEYS.filter((key) => Object.hasOwn(publication, key)),
            );
          }
          owner.mergePendingIntoStorage(acknowledgedBatch);
          owner.clearConflictRedrain();
          if (!isCurrent()) {
            return;
          }
          if (
            !superseded &&
            result.refresh.ok &&
            afterCommit &&
            sync.lastReconciledScope === sync.pendingScope
          ) {
            // The authoritative refresh published while pending intent still
            // shadowed this batch. Re-evaluate that same snapshot after cleanup
            // so a concurrent server value wins without another config.get.
            sync.lastReconciledConfigObject = null;
          }
          if (!superseded) {
            afterCommit?.({ needsRefresh: !result.refresh.ok });
          }
          if (!isCurrent()) {
            return;
          }
          break;
        }
        if (result.reason === "conflict" && attempt === 0) {
          await sleepWithAbort(250);
          continue;
        }
        if (result.reason === "conflict") {
          owner.scheduleConflictRedrain(writer, epoch);
          return;
        }
        if (
          result.reason === "error" ||
          result.reason === "unavailable" ||
          result.reason === "suspended"
        ) {
          return;
        }
        // Definitive viewer-scope or validation rejections degrade to device-local state.
        // LAST_SEEN still owns the authoritative server value per key, so identical
        // refreshes and reloads preserve this local edit; only a server delta replaces it.
        sync.pendingPrefs = removePendingUiPrefsBatch(
          sync.pendingPrefs,
          acknowledgedBatch,
          sync.pendingPersistedKeys,
        );
        owner.mergePendingIntoStorage(acknowledgedBatch);
        afterCommit?.({ needsRefresh: false, retainedLocal: true });
        break;
      }
    } finally {
      if (sync.composeSidebar === compose) {
        sync.composeSidebar = null;
      }
    }
  }
}
