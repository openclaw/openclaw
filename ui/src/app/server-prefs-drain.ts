// The existing outbox owns state and admission; load its dispatch algorithm only when intent is queued.
import { sleepWithAbort } from "@openclaw/retry";
import type { BackgroundPreference } from "../../../packages/gateway-protocol/src/schema/background-preferences.ts";
import type { ConfigPatchAck } from "../lib/config/config-gateway-operations.ts";
import {
  invalidateProfileAppearanceReads,
  loadProfileAppearancePrefs,
  recordProfileAppearanceCommit,
  resolveProfileAppearancePrefs,
  resolveProfileAppearanceProfileId,
} from "./server-prefs-profile.ts";
import {
  extractServerUiPrefs,
  isAppearancePref,
  prefValuesEqual,
  SYNCED_PREF_KEYS,
  SYNCED_PREFS,
  type ServerUiPrefs,
  type SyncedPrefKey,
} from "./server-prefs-state.ts";
import {
  LAST_SEEN_KEY,
  parseStoredPrefs,
  readStorage,
  writeStorage,
} from "./server-prefs-storage.ts";
import {
  refreshProfileAppearancePrefs,
  type ServerUiPrefsOutbox,
  type ServerUiPrefsWriter,
} from "./server-prefs.ts";
import { invalidateUserPreferences } from "./user-prefs-cache.ts";

export async function drainPendingPrefs(
  outbox: ServerUiPrefsOutbox,
  writer: ServerUiPrefsWriter,
  epoch: number,
): Promise<void> {
  while (outbox.pendingPrefs) {
    if (outbox.pushWriter !== writer || outbox.pushEpoch !== epoch) {
      return;
    }
    outbox.reconcilePersistedPendingPrefs();
    if (!outbox.pendingPrefs) {
      return;
    }
    const localOnlyKeys = SYNCED_PREF_KEYS.filter(
      (key) =>
        outbox.pendingPrefs?.[key] !== undefined &&
        (SYNCED_PREFS[key].configSync === false ||
          (key === "theme" &&
            typeof outbox.pendingPrefs.theme === "string" &&
            outbox.pendingPrefs.theme.includes("/"))) &&
        !(outbox.pushProfileId && outbox.pushCanWrite),
    );
    if (localOnlyKeys.length) {
      if (!writer.state.connected) {
        return;
      }
      // Profile-only preferences must never fall through to config.patch,
      // including intent queued before this connection's identity was known.
      outbox.cancelPendingKeys(outbox.pendingScope, localOnlyKeys);
      outbox.updateRetainedLocalKeys(outbox.pendingScope, localOnlyKeys, true);
      outbox.pushAfterCommit?.({ needsRefresh: false, retainedLocal: true });
      continue;
    }
    if (outbox.pushProfileId && outbox.pendingPrefs.theme === "custom") {
      // Offline-queued custom theme reaching a profile connection: browser-local
      // by contract, so retain it here instead of syncing it to the profile.
      outbox.cancelPendingKeys(outbox.pendingScope, ["theme"]);
      outbox.updateRetainedLocalKeys(outbox.pendingScope, ["theme"], true);
      continue;
    }
    const profileBatch: ServerUiPrefs = {};
    if (outbox.pushProfileId && outbox.pushCanWrite) {
      for (const key of SYNCED_PREF_KEYS) {
        if (isAppearancePref(key) && Object.hasOwn(outbox.pendingPrefs, key)) {
          Object.assign(profileBatch, { [key]: outbox.pendingPrefs[key] });
        }
      }
    }
    const useProfile = Object.keys(profileBatch).length > 0;
    let batch = useProfile ? profileBatch : { ...outbox.pendingPrefs };
    if (useProfile && batch.background !== undefined && Object.keys(batch).length > 1) {
      // Background has its own CAS boundary. A conflict must not reject unrelated
      // palette/font intent, so acknowledge the other preferences first.
      const { background: _background, ...themeBatch } = batch;
      batch = themeBatch;
    }
    const afterCommit = outbox.pushAfterCommit;
    const client = writer.state.client;
    const profileId = outbox.pushProfileId;
    const gatewayScope = client?.gatewayUrl ?? "";
    const isCurrent = () =>
      outbox.pushWriter === writer &&
      outbox.pushEpoch === epoch &&
      writer.state.client === client &&
      writer.state.connected &&
      resolveProfileAppearanceProfileId(gatewayScope) === profileId;
    if (useProfile && !isCurrent()) {
      return;
    }
    let expectedBackground: BackgroundPreference | null | undefined;
    if (useProfile && batch.background !== undefined && client && profileId) {
      if (!isCurrent() || !outbox.pushCanWrite) {
        return;
      }
      let profile = resolveProfileAppearancePrefs(gatewayScope, profileId);
      if (!profile) {
        // A boot mirror is not a CAS baseline. Load the authoritative profile, then
        // revalidate identity, connection, and newest intent before any write.
        invalidateUserPreferences(client);
        try {
          if (
            !(await loadProfileAppearancePrefs(client, profileId, gatewayScope)) ||
            !isCurrent()
          ) {
            return;
          }
        } catch (error) {
          if (isCurrent() && batchIsCurrent(outbox, batch)) {
            outbox.recordPreferenceWriteFailures(
              outbox.pendingScope,
              { background: batch.background },
              error,
            );
            outbox.publishPreferenceWrites();
          }
          return;
        }
        if (!batchIsCurrent(outbox, batch)) {
          continue;
        }
        profile = resolveProfileAppearancePrefs(gatewayScope, profileId);
      }
      if (!profile) {
        return;
      }
      expectedBackground = profile.background ?? null;
    }
    for (let attempt = 0; attempt < 2; attempt += 1) {
      if (
        outbox.pushWriter !== writer ||
        outbox.pushEpoch !== epoch ||
        (useProfile && !isCurrent())
      ) {
        return;
      }
      if (useProfile && writer.state.client) {
        invalidateProfileAppearanceReads();
        invalidateUserPreferences(writer.state.client);
      }
      const result = useProfile
        ? await import("./server-prefs-profile-runtime.ts").then(
            ({ writeProfileAppearancePrefs }) =>
              writeProfileAppearancePrefs(
                client,
                batch,
                isCurrent() && outbox.pushCanWrite && batchIsCurrent(outbox, batch),
                expectedBackground,
              ),
          )
        : await writer.runExternalMutation(
            (configClient) =>
              // ui.prefs is a deliberately narrow hashless LWW surface enforced by
              // hasHashlessPatchLwwStructure in the gateway. Serialization still
              // matters: a pending whole-config save must commit before this merge.
              configClient.request<ConfigPatchAck>("config.patch", {
                raw: JSON.stringify({ ui: { prefs: batch } }),
                ...(batch.sidebarEntries !== undefined
                  ? { replacePaths: ["ui.prefs.sidebarEntries"] }
                  : {}),
                note: "control-ui prefs sync",
              }),
            {
              waitForWritesResumed: true,
              configWriteAck: (ack) => ack,
              canDispatch: () => {
                if (writer.canPatch === false) {
                  return false;
                }
                outbox.reconcilePersistedPendingPrefs();
                if (batchIsCurrent(outbox, batch)) {
                  return true;
                }
                outbox.drainRequested = Boolean(outbox.pendingPrefs);
                return false;
              },
              dispatchError: "Access changed before preferences could sync.",
            },
          );
      if (
        outbox.pushWriter !== writer ||
        outbox.pushEpoch !== epoch ||
        (useProfile && !isCurrent())
      ) {
        return;
      }
      const dispatchedBatch = "batch" in result ? result.batch : batch;
      if (result.ok) {
        if (useProfile) {
          invalidateProfileAppearanceReads();
        }
        for (const key of SYNCED_PREF_KEYS) {
          if (!Object.hasOwn(dispatchedBatch, key)) {
            continue;
          }
          const failures = outbox.preferenceWriteFailures.get(outbox.pendingScope);
          if (prefValuesEqual(failures?.get(key)?.value, dispatchedBatch[key])) {
            failures?.delete(key);
          }
        }
        removeBatch(outbox, dispatchedBatch);
        const lastSeen = parseStoredPrefs(readStorage(LAST_SEEN_KEY, outbox.pendingScope)) ?? {};
        const nextLastSeen = { ...lastSeen, ...dispatchedBatch };
        if (useProfile && outbox.pushProfileId) {
          recordProfileAppearanceCommit(
            writer.state.client?.gatewayUrl ?? "",
            outbox.pushProfileId,
            dispatchedBatch,
          );
        }
        if (useProfile) {
          const configPrefs = extractServerUiPrefs(writer.state.configSnapshot?.config);
          for (const key of SYNCED_PREF_KEYS) {
            if (!Object.hasOwn(dispatchedBatch, key)) {
              continue;
            }
            if (dispatchedBatch[key] === null) {
              if (configPrefs[key] === undefined) {
                delete nextLastSeen[key];
              } else {
                Object.assign(nextLastSeen, { [key]: configPrefs[key] });
              }
            }
          }
          outbox.lastReconciledConfigObject = null;
        }
        writeStorage(LAST_SEEN_KEY, outbox.pendingScope, JSON.stringify(nextLastSeen));
        outbox.mergePendingIntoStorage(dispatchedBatch);
        outbox.publishPreferenceWrites();
        outbox.clearConflictRedrain();
        if (outbox.pushWriter !== writer || outbox.pushEpoch !== epoch) {
          return;
        }
        if (
          result.refresh.ok &&
          afterCommit &&
          outbox.lastReconciledScope === outbox.pendingScope
        ) {
          // The authoritative refresh published while pending intent still
          // shadowed this batch. Re-evaluate that same snapshot after cleanup
          // so a concurrent server value wins without another config.get.
          outbox.lastReconciledConfigObject = null;
        }
        afterCommit?.({ needsRefresh: !result.refresh.ok });
        if (outbox.pushWriter !== writer || outbox.pushEpoch !== epoch) {
          return;
        }
        break;
      }
      if (
        result.reason === "conflict" &&
        useProfile &&
        dispatchedBatch.background !== undefined &&
        client &&
        profileId
      ) {
        // Do not rebase an old selection over a newer upload/None. Preserve the
        // latest local intent as a visible failure and require an explicit retry.
        const value =
          outbox.pendingPrefs && Object.hasOwn(outbox.pendingPrefs, "background")
            ? outbox.pendingPrefs.background
            : dispatchedBatch.background;
        outbox.cancelPendingKeys(outbox.pendingScope, ["background"]);
        outbox.recordPreferenceWriteFailures(
          outbox.pendingScope,
          { background: value },
          "Background changed elsewhere. Review the latest selection, then retry your change.",
          true,
        );
        outbox.updateRetainedLocalKeys(outbox.pendingScope, ["background"], true);
        outbox.publishPreferenceWrites();
        invalidateProfileAppearanceReads(true);
        invalidateUserPreferences(client);
        await refreshProfileAppearancePrefs({
          client,
          profileId,
          scope: gatewayScope,
          configObject: writer.state.configSnapshot?.config,
          onApplied: () => undefined,
        }).catch(() => false);
        if (isCurrent()) {
          afterCommit?.({ needsRefresh: false, retainedLocal: true });
        }
        if (!isCurrent()) {
          return;
        }
        // Only background needs explicit retry. Continue unrelated intent after
        // rechecking retirement across both the refresh and the commit callback.
        break;
      }
      if (result.reason === "conflict" && attempt === 0) {
        await sleepWithAbort(250);
        continue;
      }
      if (result.reason === "conflict") {
        outbox.scheduleConflictRedrain(writer, epoch);
        return;
      }
      if (result.reason === "error" || result.reason === "rejected") {
        const failed = Object.fromEntries(
          SYNCED_PREF_KEYS.filter(
            (key) =>
              Object.hasOwn(dispatchedBatch, key) &&
              prefValuesEqual(outbox.pendingPrefs?.[key], dispatchedBatch[key]),
          ).map((key) => [key, dispatchedBatch[key]]),
        );
        outbox.recordPreferenceWriteFailures(
          outbox.pendingScope,
          failed,
          result.error,
          result.reason === "rejected",
        );
        outbox.publishPreferenceWrites();
      }
      if (
        result.reason === "unavailable" &&
        writer.state.connected &&
        !batchIsCurrent(outbox, dispatchedBatch)
      ) {
        // A newer edit can supersede this batch while its lazy transport loads.
        // Drain that intent now rather than leaving it pending until reconnect.
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
      removeBatch(outbox, dispatchedBatch);
      outbox.mergePendingIntoStorage(dispatchedBatch);
      afterCommit?.({ needsRefresh: false, retainedLocal: true });
      // A rejected theme must not strand independent background intent.
      break;
    }
  }
}

function batchIsCurrent(outbox: ServerUiPrefsOutbox, batch: ServerUiPrefs): boolean {
  const current = outbox.pendingPrefs;
  return Boolean(
    current &&
    // Preserve invalid persisted keys too, until the server can reject the complete batch.
    // SAFETY: Keys only index same-key comparisons; the assertion grants no validation or authority.
    (Object.keys(batch) as SyncedPrefKey[]).every(
      (key) => Object.hasOwn(current, key) && prefValuesEqual(current[key], batch[key]),
    ),
  );
}

function removeBatch(outbox: ServerUiPrefsOutbox, batch: ServerUiPrefs): void {
  if (!outbox.pendingPrefs) {
    return;
  }
  // Unknown persisted keys must also be removed after rejection, or the drain cannot settle.
  // SAFETY: Keys only index exact matching records/set entries; they are not treated as valid prefs.
  for (const key of Object.keys(batch) as SyncedPrefKey[]) {
    if (prefValuesEqual(outbox.pendingPrefs[key], batch[key])) {
      delete outbox.pendingPrefs[key];
      outbox.pendingPersistedKeys.delete(key);
    }
  }
  if (!Object.keys(outbox.pendingPrefs).length) {
    outbox.pendingPrefs = null;
  }
}
