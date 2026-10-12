import { sleepWithAbort } from "@openclaw/retry";
import type { BackgroundPreference } from "../../../packages/gateway-protocol/src/schema/background-preferences.ts";
import type { ConfigPatchAck } from "../lib/config/config-draft-model.ts";
import { showToast } from "../lib/toast.ts";
import { readConfirmedPrefs, publishConfirmedPrefs } from "./server-prefs-confirmation.ts";
import { foldSidebarEntriesBase, hasSidebarOrderIntent } from "./server-prefs-intent.ts";
import {
  resolveProfileAppearancePrefs,
  resolveProfileAppearanceProfileId,
  invalidateProfileAppearanceReads,
  recordProfileAppearanceCommit,
} from "./server-prefs-profile.ts";
import {
  refreshProfileAppearancePrefs,
  loadProfileAppearancePrefs,
} from "./server-prefs-reconcile.ts";
import {
  SYNCED_PREF_KEYS,
  SYNCED_PREFS,
  prefValuesEqual,
  clearSidebarEntriesMetadata,
  type ServerUiPrefs,
} from "./server-prefs-state.ts";
import type { ServerUiPrefsSync, ServerUiPrefsWriter } from "./server-prefs-sync-contract.ts";
import {
  selectProfileUiPrefs,
  removePendingUiPrefsBatch,
  serverUiPrefsCommittedSnapshot,
} from "./server-prefs-write-batch.ts";
import type { UiSettings } from "./settings-contract.ts";
import { invalidateUserPreferences } from "./user-prefs-cache.ts";

// Operation-only code: the synchronous preference owner retains its outbox and
// all generation/authority facts, exposed live across every awaited boundary.
export async function drainPendingPrefs(
  sync: ServerUiPrefsSync,
  writer: ServerUiPrefsWriter,
  epoch: number,
): Promise<void> {
  const isCurrent = () => sync.pushWriter === writer && sync.pushEpoch === epoch;
  while (sync.pendingPrefs) {
    if (!isCurrent()) {
      return;
    }
    sync.reconcilePersistedPendingPrefs();
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
      sync.cancelPendingKeys(sync.pendingScope, localOnlyKeys);
      sync.updateRetainedLocalKeys(sync.pendingScope, localOnlyKeys, true);
      sync.pushAfterCommit?.({ needsRefresh: false, retainedLocal: true });
      continue;
    }
    if (sync.pushProfileId && sync.pendingPrefs.theme === "custom") {
      // Offline-queued custom theme reaching a profile connection: browser-local
      // by contract, so retain it here instead of syncing it to the profile.
      sync.cancelPendingKeys(sync.pendingScope, ["theme"]);
      sync.updateRetainedLocalKeys(sync.pendingScope, ["theme"], true);
      continue;
    }
    const profileBatch =
      sync.pushProfileId && sync.pushCanWrite ? selectProfileUiPrefs(sync.pendingPrefs) : {};
    const useProfile = Object.keys(profileBatch).length > 0;
    let batch = useProfile ? profileBatch : { ...sync.pendingPrefs };
    if (!useProfile) {
      clearSidebarEntriesMetadata(batch);
      delete batch.navigationConfirmation;
    }
    if (!Object.keys(batch).length) {
      sync.pendingPrefs = null;
      sync.writePendingStorage(null);
      sync.publishPreferenceWrites();
      return;
    }
    if (useProfile && batch.background !== undefined && Object.keys(batch).length > 1) {
      // Background CAS conflicts must not reject or strand unrelated intent.
      const { background: _background, ...otherPrefs } = batch;
      batch = otherPrefs;
    }
    const afterCommit = sync.pushAfterCommit;
    const capturedClient = writer.state.client;
    const profileId = sync.pushProfileId;
    const gatewayScope = capturedClient?.gatewayUrl ?? "";
    const profileIsCurrent = () =>
      isCurrent() &&
      writer.state.client === capturedClient &&
      writer.state.connected &&
      resolveProfileAppearanceProfileId(gatewayScope) === profileId;
    if (useProfile && !profileIsCurrent()) {
      return;
    }
    let expectedBackground: BackgroundPreference | null | undefined;
    if (useProfile && batch.background !== undefined && capturedClient && profileId) {
      if (!sync.pushCanWrite) {
        return;
      }
      let profile = resolveProfileAppearancePrefs(gatewayScope, profileId);
      if (!profile) {
        invalidateUserPreferences(capturedClient);
        try {
          if (
            !(await loadProfileAppearancePrefs(capturedClient, profileId, gatewayScope, {
              isCurrent: profileIsCurrent,
            })) ||
            !profileIsCurrent()
          ) {
            return;
          }
        } catch (error) {
          if (profileIsCurrent() && sync.batchIsCurrent(batch)) {
            sync.recordPreferenceWriteFailures(
              sync.pendingScope,
              { background: batch.background },
              error,
            );
            sync.publishPreferenceWrites();
          }
          return;
        }
        sync.reconcilePersistedPendingPrefs();
        if (!sync.batchIsCurrent(batch)) {
          continue;
        }
        profile = resolveProfileAppearancePrefs(gatewayScope, profileId);
      }
      if (!profile) {
        return;
      }
      expectedBackground = profile.background ?? null;
    }
    const navigationReceipt = batch.sidebarEntries !== undefined;
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
        if (!isCurrent() || (useProfile && !profileIsCurrent())) {
          return;
        }
        if (useProfile && writer.state.client) {
          invalidateProfileAppearanceReads();
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
                      !profileIsCurrent() ||
                      writer.state.client !== capturedClient ||
                      !writer.state.connected ||
                      !sync.pushCanWrite
                    ) {
                      return false;
                    }
                    sync.reconcilePersistedPendingPrefs();
                    if (sync.batchIsCurrent(batch)) {
                      if (navigationReceipt) {
                        lastSeenAtDispatch = readConfirmedPrefs(sync, sync.pendingScope) ?? {};
                      }
                      return true;
                    }
                    sync.drainRequested = Boolean(sync.pendingPrefs);
                    return false;
                  },
                  profileId,
                  expectedBackground,
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
                // The shared Settings draft adopts the receipt before its trailing save.
                configWriteAck: (value) => value,
                shouldRefresh: () => false,
                canDispatch: () => {
                  if (
                    !isCurrent() ||
                    writer.state.client !== capturedClient ||
                    writer.canPatch === false
                  ) {
                    return false;
                  }
                  sync.reconcilePersistedPendingPrefs();
                  if (sync.batchIsCurrent(batch)) {
                    return true;
                  }
                  sync.drainRequested = Boolean(sync.pendingPrefs);
                  return false;
                },
                dispatchError: "Access changed before preferences could sync.",
              },
            );
        if (!isCurrent() || (useProfile && !profileIsCurrent())) {
          return;
        }
        sync.reconcilePersistedPendingPrefs();
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
          if (useProfile) {
            invalidateProfileAppearanceReads();
          }
          for (const key of SYNCED_PREF_KEYS) {
            if (!Object.hasOwn(dispatchedBatch, key)) {
              continue;
            }
            const failures = sync.preferenceWriteFailures.get(sync.pendingScope);
            if (prefValuesEqual(failures?.get(key)?.value, dispatchedBatch[key])) {
              failures?.delete(key);
            }
          }
          const committedBatch =
            "committedBatch" in result
              ? (result.committedBatch ?? dispatchedBatch)
              : dispatchedBatch;
          let lastSeen = readConfirmedPrefs(sync, sync.pendingScope) ?? {};
          if (
            navigationReceipt &&
            capturedClient &&
            profileId &&
            sync.pendingPrefs &&
            Object.hasOwn(sync.pendingPrefs, "sidebarEntries") &&
            lastSeen.navigationConfirmation?.sidebarEntries !==
              lastSeenAtDispatch.navigationConfirmation?.sidebarEntries &&
            !prefValuesEqual(lastSeen.sidebarEntries, committedBatch.sidebarEntries)
          ) {
            // Reconnect hydration can publish the pre-write pins while replay is in flight.
            invalidateUserPreferences(capturedClient);
            await refreshProfileAppearancePrefs({
              client: capturedClient,
              profileId,
              scope: gatewayScope,
              configObject: writer.state.configSnapshot?.config,
              onApplied: () => undefined,
              isCurrent: profileIsCurrent,
            }).catch(() => false);
            if (!isCurrent() || !profileIsCurrent()) {
              return;
            }
            sync.reconcilePersistedPendingPrefs();
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
          const confirmedNavigation: ServerUiPrefs = {};
          const latestNavigation: Partial<Pick<UiSettings, "sidebarEntries">> = {};
          if (navigationReceipt) {
            // Shared lastSeen is already-confirmed profile-only navigation. Keep the
            // local read cache aligned so a later reconcile cannot roll it backward.
            const confirmed = SYNCED_PREFS.sidebarEntries.extract(lastSeen.sidebarEntries);
            if (profilePrefs && confirmed !== undefined) {
              confirmedNavigation.sidebarEntries = confirmed;
            }
            const held = sync.pendingPrefs && Object.hasOwn(sync.pendingPrefs, "sidebarEntries");
            const newer =
              (lastSeen.navigationConfirmation?.sidebarEntries !==
                lastSeenAtDispatch.navigationConfirmation?.sidebarEntries ||
                !prefValuesEqual(lastSeen.sidebarEntries, lastSeenAtDispatch.sidebarEntries)) &&
              !prefValuesEqual(lastSeen.sidebarEntries, committedBatch.sidebarEntries);
            if (Object.hasOwn(publication, "sidebarEntries") && (!held || newer)) {
              // Clearing an outbox may mean a sibling settled or the user cancelled,
              // not permission for this older receipt to publish its committed value.
              delete publication.sidebarEntries;
              superseded = true;
              if (held && newer && confirmed !== undefined) {
                latestNavigation.sidebarEntries = confirmed;
              }
            }
          }
          if (useProfile && profileId) {
            recordProfileAppearanceCommit(gatewayScope, profileId, confirmedNavigation);
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
          if (useProfile && profileId) {
            recordProfileAppearanceCommit(gatewayScope, profileId, publication);
          }
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
          if (sync.pendingPrefs && Object.hasOwn(sync.pendingPrefs, "sidebarEntries")) {
            delete latestNavigation.sidebarEntries;
          }
          if (Object.keys(latestNavigation).length) {
            sync.applyServerPrefsPatch(latestNavigation);
          }
          if (Object.keys(publication).length) {
            publishConfirmedPrefs(
              sync,
              sync.pendingScope,
              nextLastSeen,
              SYNCED_PREF_KEYS.filter((key) => Object.hasOwn(publication, key)),
            );
          }
          sync.mergePendingIntoStorage(acknowledgedBatch);
          sync.publishPreferenceWrites();
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
        if (
          result.reason === "conflict" &&
          useProfile &&
          dispatchedBatch.background !== undefined &&
          capturedClient &&
          profileId
        ) {
          // An old selection must never rebase over a newer upload/None. Keep the
          // newest local intent as a visible failure requiring explicit retry.
          const value =
            sync.pendingPrefs && Object.hasOwn(sync.pendingPrefs, "background")
              ? sync.pendingPrefs.background
              : dispatchedBatch.background;
          sync.cancelPendingKeys(sync.pendingScope, ["background"]);
          sync.recordPreferenceWriteFailures(
            sync.pendingScope,
            { background: value },
            "Background changed elsewhere. Review the latest selection, then retry your change.",
            true,
          );
          sync.updateRetainedLocalKeys(sync.pendingScope, ["background"], true);
          sync.publishPreferenceWrites();
          invalidateProfileAppearanceReads(true);
          invalidateUserPreferences(capturedClient);
          await refreshProfileAppearancePrefs({
            client: capturedClient,
            profileId,
            scope: gatewayScope,
            configObject: writer.state.configSnapshot?.config,
            onApplied: () => undefined,
            isCurrent: profileIsCurrent,
          }).catch(() => false);
          if (profileIsCurrent()) {
            afterCommit?.({ needsRefresh: false, retainedLocal: true });
          }
          if (!profileIsCurrent()) {
            return;
          }
          break;
        }
        if (result.reason === "conflict" && attempt === 0) {
          await sleepWithAbort(250);
          continue;
        }
        if (result.reason === "conflict") {
          // Repeated contention waits for the next edit, explicit retry, or reconnect.
          sync.recordPreferenceWriteFailures(sync.pendingScope, dispatchedBatch, result.error);
          sync.publishPreferenceWrites();
          return;
        }
        if (result.reason === "error" || result.reason === "rejected") {
          const failed = Object.fromEntries(
            SYNCED_PREF_KEYS.filter(
              (key) =>
                Object.hasOwn(dispatchedBatch, key) &&
                sync.pendingPrefs &&
                Object.hasOwn(sync.pendingPrefs, key) &&
                prefValuesEqual(sync.pendingPrefs[key], dispatchedBatch[key]),
            ).map((key) => [key, dispatchedBatch[key]]),
          );
          sync.recordPreferenceWriteFailures(
            sync.pendingScope,
            failed,
            result.error,
            result.reason === "rejected",
          );
          const localPins = SYNCED_PREFS.sidebarEntries.extract(failed.sidebarEntries);
          if (result.reason === "rejected" && localPins && sync.batchIsCurrent(acknowledgedBatch)) {
            // Preserve the choice in the existing profile mirror before retiring its
            // unwritable outbox entry; other preferences must still be allowed to drain.
            sync.applyServerPrefsPatch({ sidebarEntries: localPins });
            sync.updateRetainedLocalKeys(sync.pendingScope, ["sidebarEntries"], true);
            showToast({ message: result.error });
          }
          sync.publishPreferenceWrites();
        }
        if (
          result.reason === "unavailable" &&
          writer.state.connected &&
          !sync.batchIsCurrent(dispatchedBatch)
        ) {
          break;
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
        sync.mergePendingIntoStorage(acknowledgedBatch);
        sync.publishPreferenceWrites();
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
