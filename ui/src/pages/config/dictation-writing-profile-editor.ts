import {
  BASELINE_WRITING_POLICY,
  WRITING_PROFILE_LIMITS,
  type WritingProfile,
  type WritingProfileCatalog,
  type WritingProfileIssue,
} from "../../../../src/shared/dictation-writing-profiles.js";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import {
  exportWritingProfilePreferences,
  importWritingProfilePreferences,
  loadWritingProfilePreferences,
  saveWritingProfilePreferences,
  type WritingProfilePreferenceSnapshot,
} from "../../app/dictation-writing-profile-preferences.ts";
import type { ApplicationGateway } from "../../app/gateway.ts";
import { invalidateUserPreferences } from "../../app/user-prefs-cache.ts";

export type WritingProfileEditorStatus =
  | "loading"
  | "ready"
  | "edited"
  | "saving"
  | "saved"
  | "imported"
  | "conflict"
  | "invalid"
  | "read-only"
  | "no-durable-identity"
  | "offline"
  | "stale"
  | "error";

export type WritingProfileEditorSnapshot = Readonly<{
  status: WritingProfileEditorStatus;
  busy: boolean;
  connected: boolean;
  requiresReload: boolean;
  current: WritingProfilePreferenceSnapshot | null;
  draft: WritingProfileCatalog | null;
  selectedId: string | null;
  dirty: boolean;
  issues: readonly WritingProfileIssue[];
  quarantinedImport: string | null;
}>;

const emptySnapshot = (): WritingProfileEditorSnapshot => ({
  status: "loading",
  busy: false,
  connected: false,
  requiresReload: false,
  current: null,
  draft: null,
  selectedId: null,
  dirty: false,
  issues: [],
  quarantinedImport: null,
});

/** A page-local draft. The accepted user-preferences receipt remains the write authority. */
export function createWritingProfileEditor(gateway: ApplicationGateway) {
  let snapshot = emptySnapshot();
  let client: GatewayBrowserClient | null = null;
  let profileId: string | null = null;
  let connectionRevision = -1;
  let admittedGeneration: number | undefined;
  let recoveryScope: string | undefined;
  let generation = 0;
  let active = false;
  const listeners = new Set<() => void>();
  const publish = (patch: Partial<WritingProfileEditorSnapshot>) => {
    snapshot = { ...snapshot, ...patch };
    listeners.forEach((listener) => listener());
  };
  const capture = () => {
    const requestClient = client;
    const requestProfileId = profileId;
    const requestGeneration = ++generation;
    if (!active || !requestClient || !requestProfileId || !snapshot.connected) {
      return null;
    }
    return {
      client: requestClient,
      profileId: requestProfileId,
      isCurrent: () =>
        active &&
        generation === requestGeneration &&
        gateway.snapshot.phase === "connected" &&
        gateway.snapshot.client === requestClient &&
        gateway.snapshot.selfUser?.id === requestProfileId &&
        gateway.connectionRevision === connectionRevision,
    };
  };
  const accept = (
    current: WritingProfilePreferenceSnapshot,
    status: WritingProfileEditorStatus,
  ) => {
    const catalog = current.catalog;
    const selectedId = catalog?.profiles.some((profile) => profile.id === snapshot.selectedId)
      ? snapshot.selectedId
      : (catalog?.profiles[0]?.id ?? null);
    publish({
      current,
      draft: catalog,
      selectedId,
      dirty: false,
      requiresReload: false,
      busy: false,
      issues: current.issues,
      quarantinedImport: null,
      status: current.readOnlyReason ? "read-only" : status,
    });
  };
  async function reload() {
    if (snapshot.busy) {
      return;
    }
    const request = capture();
    if (!request) {
      return;
    }
    invalidateUserPreferences(request.client);
    publish({ busy: true, status: "loading" });
    const result = await loadWritingProfilePreferences(request.client, request.profileId, request);
    if (!request.isCurrent()) {
      return;
    }
    if (result.status === "ok") {
      accept(result.current, "ready");
    } else {
      publish({ busy: false, status: result.status, requiresReload: Boolean(snapshot.current) });
    }
  }
  function syncConnection() {
    const next = gateway.snapshot;
    // A reconnect temporarily leaves users.self unresolved; it is not a sign-out.
    const identityResolved = next.selfUser !== undefined;
    const nextProfileId = identityResolved ? (next.selfUser?.id ?? null) : profileId;
    const nextRecoveryScope = next.client?.recoveryScopeReady
      ? next.client.recoveryScope
      : undefined;
    const changed =
      next.client !== client ||
      (identityResolved && nextProfileId !== profileId) ||
      gateway.connectionRevision !== connectionRevision ||
      (recoveryScope !== undefined &&
        nextRecoveryScope !== undefined &&
        recoveryScope !== nextRecoveryScope);
    if (changed) {
      generation += 1;
      client = next.client;
      profileId = nextProfileId;
      connectionRevision = gateway.connectionRevision;
      admittedGeneration = next.client?.connectionGeneration;
      recoveryScope = nextRecoveryScope;
      snapshot = emptySnapshot();
    }
    if (nextRecoveryScope !== undefined) {
      recoveryScope = nextRecoveryScope;
    }
    const connected = next.phase === "connected" && Boolean(client);
    if (!connected || !identityResolved || !profileId) {
      generation += 1;
      publish({
        connected: false,
        busy: false,
        requiresReload: Boolean(snapshot.current),
        status: !connected ? "offline" : identityResolved ? "no-durable-identity" : "loading",
      });
      return;
    }
    const resumed = !snapshot.connected;
    const bindingChanged = admittedGeneration !== next.client?.connectionGeneration;
    if (changed || resumed || bindingChanged) {
      admittedGeneration = next.client?.connectionGeneration;
      const requiresReload =
        snapshot.requiresReload || (bindingChanged && Boolean(snapshot.current));
      publish({
        connected: true,
        requiresReload,
        status: requiresReload ? "stale" : snapshot.dirty ? "edited" : "ready",
      });
      if (!snapshot.current || (!snapshot.dirty && !snapshot.quarantinedImport && requiresReload)) {
        void reload();
      }
    }
  }
  const edit = (next: WritingProfileCatalog) => {
    if (snapshot.busy || !snapshot.connected || snapshot.current?.readOnlyReason) {
      return;
    }
    publish({
      draft: { ...next, revision: crypto.randomUUID() },
      dirty: true,
      status: snapshot.requiresReload ? "stale" : "edited",
      issues: [],
      quarantinedImport: null,
    });
  };
  const selected = () =>
    snapshot.draft?.profiles.find((profile) => profile.id === snapshot.selectedId) ?? null;

  return {
    get snapshot() {
      return snapshot;
    },
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    start() {
      active = true;
      const unsubscribe = gateway.subscribe(syncConnection);
      syncConnection();
      return () => {
        active = false;
        generation += 1;
        unsubscribe();
      };
    },
    reload,
    select(id: string) {
      if (snapshot.draft?.profiles.some((profile) => profile.id === id)) {
        publish({ selectedId: id });
      }
    },
    updateCatalog(patch: Partial<Pick<WritingProfileCatalog, "enabled" | "defaultProfileId">>) {
      if (snapshot.draft) {
        edit({ ...snapshot.draft, ...patch });
      }
    },
    add(label: string) {
      const draft = snapshot.draft;
      if (!draft || snapshot.busy || draft.profiles.length >= WRITING_PROFILE_LIMITS.profiles) {
        return;
      }
      const id = crypto.randomUUID();
      edit({
        ...draft,
        profiles: [
          ...draft.profiles,
          {
            id,
            revision: crypto.randomUUID(),
            label,
            enabled: false,
            priority: 0,
            selectors: [],
            policy: BASELINE_WRITING_POLICY,
          },
        ],
      });
      if (snapshot.draft?.profiles.some((profile) => profile.id === id)) {
        publish({ selectedId: id });
      }
    },
    updateProfile(patch: Partial<Omit<WritingProfile, "id" | "revision">>) {
      const profile = selected();
      const draft = snapshot.draft;
      if (profile && draft) {
        edit({
          ...draft,
          profiles: draft.profiles.map((item) =>
            item.id === profile.id
              ? Object.assign({}, item, patch, { revision: crypto.randomUUID() })
              : item,
          ),
        });
      }
    },
    remove() {
      const profile = selected();
      const draft = snapshot.draft;
      if (profile && draft) {
        edit({
          ...draft,
          defaultProfileId: draft.defaultProfileId === profile.id ? null : draft.defaultProfileId,
          profiles: draft.profiles.filter((item) => item.id !== profile.id),
        });
        if (!snapshot.draft?.profiles.some((item) => item.id === profile.id)) {
          publish({ selectedId: snapshot.draft?.profiles[0]?.id ?? null });
        }
      }
    },
    async save() {
      if (
        snapshot.busy ||
        snapshot.requiresReload ||
        !snapshot.dirty ||
        !snapshot.current ||
        !snapshot.draft
      ) {
        return;
      }
      const request = capture();
      if (!request) {
        return;
      }
      const { current, draft } = snapshot;
      publish({ busy: true, status: "saving" });
      const result = await saveWritingProfilePreferences(request.client, current, draft, request);
      if (!request.isCurrent()) {
        return;
      }
      if (result.status === "ok") {
        accept(result.current, "saved");
      } else {
        publish({
          busy: false,
          status: result.status,
          requiresReload:
            result.status === "conflict" || result.status === "stale" || result.status === "error",
          issues: result.status === "invalid" ? result.issues : [],
        });
      }
    },
    async import(text: string) {
      if (snapshot.busy || snapshot.requiresReload || snapshot.dirty || !snapshot.current) {
        return;
      }
      const request = capture();
      if (!request) {
        return;
      }
      const current = snapshot.current;
      publish({ busy: true, status: "saving" });
      const result = await importWritingProfilePreferences(request.client, current, text, request);
      if (!request.isCurrent()) {
        return;
      }
      if (result.status === "ok") {
        accept(result.current, "imported");
      } else {
        publish({
          busy: false,
          status: result.status,
          requiresReload:
            result.status === "conflict" || result.status === "stale" || result.status === "error",
          issues: result.status === "invalid" ? result.issues : [],
          quarantinedImport:
            result.status === "invalid" ? (result.quarantinedImport ?? null) : null,
        });
      }
    },
    exportSaved() {
      return snapshot.current ? exportWritingProfilePreferences(snapshot.current) : null;
    },
    exportDraft() {
      return snapshot.draft ? JSON.stringify(snapshot.draft, null, 2) : null;
    },
  };
}

export type WritingProfileEditor = ReturnType<typeof createWritingProfileEditor>;
