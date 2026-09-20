import { USER_PREFS_ENTRY_LIMIT } from "../../../../packages/gateway-protocol/src/schema/user-profile-constants.ts";
import type { ApplicationContext } from "../../app/context.ts";
import { saveUserPreferences } from "../../app/user-prefs-cache.ts";
import { t } from "../../i18n/index.ts";
import { registerNewSessionSetupEnglish } from "../../i18n/locales/en-new-session-setup.ts";
import { isGatewayMethodAdvertised } from "../../lib/gateway-methods.ts";
import { normalizeAgentId } from "../../lib/sessions/session-key.ts";
import { showToast } from "../../lib/toast.ts";
import * as catalog from "./catalog-target.ts";
import type { NewSessionRouteData } from "./location.ts";
import {
  decodeIdentityPreferences,
  encodeIdentityPreferences,
  loadBrowserPreferences,
  loadNewSessionPreference,
  PREFS_MIGRATION_KEY,
  replaceBrowserPreference,
  resolveNewSessionFolderPreference,
  type NewSessionPreference,
} from "./preferences.ts";

registerNewSessionSetupEnglish();

export type SubmittedWorktreePreference = NewSessionPreference & {
  // Fresh drafts know the stored override; recovery only retains the effective create input.
  selectedBaseRef?: string;
};

type DraftPreferenceSnapshot = Readonly<{
  source: ApplicationContext["gateway"] | null;
  client: ApplicationContext["gateway"]["snapshot"]["client"];
  gatewayUrl: string;
  recoveryScope: string;
  bootId: string;
  connected: boolean;
  connectionEpoch: number;
  data: NewSessionRouteData | undefined;
  pendingPlacementSessionKey: string;
  agentsHydrated: boolean;
}>;

type PreferenceScope = Pick<
  DraftPreferenceSnapshot,
  "source" | "client" | "connected" | "recoveryScope" | "connectionEpoch"
> & { profileId: string | undefined };

type PreferenceWriter = { selection: object; write: Promise<void> };
type PreferenceWrites = {
  agents: Map<string, PreferenceWriter>;
  revision: object;
  listeners: Set<(agentId: string, preference: NewSessionPreference, consumed: boolean) => void>;
};

export class DraftPreferenceState {
  private static readonly preferenceWriters = new WeakMap<
    ApplicationContext["gateway"],
    PreferenceWrites
  >();
  private preferenceScope: PreferenceScope | undefined;
  private preferenceModeValue: "local" | "loading" | "remote" = "local";
  private identityPreferences: Record<string, NewSessionPreference> = {};
  private preferenceLoad: Promise<void> = Promise.resolve();
  private stopPreferencePublication: (() => void) | undefined;

  constructor(
    private readonly read: () => DraftPreferenceSnapshot,
    private readonly callbacks: { requestUpdate: () => void; onAdoptAgentDefaults: () => void },
  ) {}

  get loading(): boolean {
    return this.preferenceModeValue === "loading";
  }

  synchronize() {
    const state = this.read();
    const gateway = state.source;
    if (!gateway) {
      return;
    }
    const scope: PreferenceScope = { ...state, profileId: gateway.snapshot.selfUser?.id };
    const keys = [
      "source",
      "client",
      "connected",
      "recoveryScope",
      "connectionEpoch",
      "profileId",
    ] as const;
    if (this.preferenceScope && keys.every((key) => scope[key] === this.preferenceScope?.[key])) {
      return;
    }
    this.disconnect();
    this.preferenceScope = scope;
    this.identityPreferences = {};
    const { client, connected, recoveryScope, profileId } = scope;
    if (connected) {
      const listeners = this.preferenceWrites(gateway).listeners;
      const listener = (agentId: string, preference: NewSessionPreference, consumed: boolean) => {
        const snapshot = gateway.snapshot;
        if (
          this.preferenceScope !== scope ||
          snapshot.client !== client ||
          snapshot.hello?.auth?.recoveryScope !== recoveryScope ||
          snapshot.selfUser?.id !== profileId
        ) {
          return;
        }
        this.identityPreferences = { ...this.identityPreferences, [agentId]: preference };
        if (consumed) {
          this.adoptPreferences();
        } else {
          this.callbacks.requestUpdate();
        }
      };
      listeners.add(listener);
      this.stopPreferencePublication = () => listeners.delete(listener);
    }
    const remote =
      connected &&
      client &&
      profileId &&
      isGatewayMethodAdvertised(gateway.snapshot, "users.prefs.get") === true &&
      isGatewayMethodAdvertised(gateway.snapshot, "users.prefs.set") === true;
    this.preferenceModeValue = remote ? "loading" : "local";
    this.preferenceLoad = remote
      ? this.loadIdentityPreferences({ client, profileId, gatewayUrl: state.gatewayUrl, scope })
      : Promise.resolve();
  }

  disconnect() {
    this.stopPreferencePublication?.();
    this.stopPreferencePublication = undefined;
    this.preferenceScope = undefined;
  }

  private adoptPreferences() {
    if (this.read().agentsHydrated) {
      this.callbacks.onAdoptAgentDefaults();
    }
    this.callbacks.requestUpdate();
  }

  readPreference(agentId: string): NewSessionPreference | null {
    const snapshot = this.read();
    if (
      catalog.isTarget(snapshot.data) ||
      snapshot.data?.group ||
      snapshot.pendingPlacementSessionKey
    ) {
      return null;
    }
    return this.preferenceModeValue === "remote"
      ? (this.identityPreferences[normalizeAgentId(agentId)] ?? null)
      : loadNewSessionPreference(this.read().gatewayUrl, agentId);
  }

  private preferenceWrites(source: ApplicationContext["gateway"]): PreferenceWrites {
    let writes = DraftPreferenceState.preferenceWriters.get(source);
    if (!writes) {
      writes = { agents: new Map(), revision: {}, listeners: new Set() };
      DraftPreferenceState.preferenceWriters.set(source, writes);
    }
    return writes;
  }

  capturePreferenceConsumption(
    agentId: string,
    workspace: string,
    expected: SubmittedWorktreePreference,
  ) {
    return this.preparePreferenceWrite(agentId, workspace, { worktreeName: "" }, expected);
  }

  persistPreference(agentId: string, workspace: string, patch: NewSessionPreference) {
    return this.preparePreferenceWrite(agentId, workspace, patch)?.();
  }

  private preparePreferenceWrite(
    agentIdValue: string,
    workspace: string,
    patch: NewSessionPreference,
    expected?: SubmittedWorktreePreference,
  ): ((consume?: () => void) => void | Promise<void>) | undefined {
    const { source, client, gatewayUrl, recoveryScope, bootId, data, pendingPlacementSessionKey } =
      this.read();
    const accepted = expected !== undefined;
    const persist =
      !catalog.isTarget(data) && !data?.group && (accepted || !pendingPlacementSessionKey);
    if (!persist && !accepted) {
      return undefined;
    }
    if (!source) {
      return undefined;
    }
    const scope = this.preferenceScope;
    const profileId = source.snapshot.selfUser?.id;
    const preferenceLoad = this.preferenceLoad;
    const agentId = normalizeAgentId(agentIdValue);
    const writes = this.preferenceWrites(source);
    let writer = writes.agents.get(agentId);
    if (!writer) {
      writer = { selection: {}, write: Promise.resolve() };
      writes.agents.set(agentId, writer);
    }
    const capturedSelection = writer.selection;
    const ownsConnection = () =>
      Boolean(
        client &&
        source.snapshot.client === client &&
        source.snapshot.phase === "connected" &&
        source.connection.gatewayUrl === gatewayUrl &&
        client.recoveryScope === recoveryScope &&
        (source.snapshot.hello?.auth?.recoveryScope ?? "") === recoveryScope &&
        source.snapshot.hello?.server?.bootId === bootId &&
        source.snapshot.selfUser?.id === profileId,
      );
    const nextPatch = accepted ? patch : { workspace, ...patch };
    const matchSubmitted = (current: NewSessionPreference | null | undefined) => {
      if (!expected) {
        return "match";
      }
      if (
        !current ||
        current.worktreeName !== expected.worktreeName ||
        current.worktree !== true ||
        (current.workspace ?? workspace) !== workspace ||
        resolveNewSessionFolderPreference(current, workspace).folder !== expected.folder ||
        (current.projectId ?? "") !== (expected.projectId ?? "")
      ) {
        return "superseded";
      }
      if (expected.selectedBaseRef !== undefined) {
        return (current.baseRef ?? "") === expected.selectedBaseRef ? "match" : "superseded";
      }
      if (!current.baseRef && expected.baseRef) {
        // Recovery cannot distinguish an original default from another draft clearing its base.
        return "unconfirmed";
      }
      return (current.baseRef ?? "") === (expected.baseRef ?? "") ? "match" : "superseded";
    };
    return async (consume) => {
      if (accepted && (!ownsConnection() || writer.selection !== capturedSelection)) {
        return;
      }
      // Model controls share persistence, but do not replace the submitted checkout intent.
      const changesPlacement = Object.keys(patch).some(
        (field) => !["model", "agentRuntime", "thinkingLevel"].includes(field),
      );
      const selection = changesPlacement ? {} : writer.selection;
      writer.selection = selection;
      consume?.();
      if (!persist) {
        return;
      }
      const isCurrent = () =>
        accepted
          ? ownsConnection() && writer.selection === selection
          : ownsConnection() && this.preferenceScope === scope;
      // A disconnected controller must still fence work admitted to its Gateway queue.
      const queued = this.preferenceModeValue !== "local";
      const write = async () => {
        if (queued) {
          await preferenceLoad;
          if (!client || !isCurrent()) {
            return undefined;
          }
        }
        try {
          for (let attempt = 0; attempt < 3; attempt += 1) {
            let current: Record<string, unknown> | undefined;
            if (this.preferenceModeValue !== "local") {
              if (!client || !profileId || !isCurrent()) {
                return undefined;
              }
              const { loadUserPreferences } = await import("../../app/user-prefs-request.ts");
              const result = await loadUserPreferences(client, profileId);
              if (!isCurrent()) {
                return undefined;
              }
              if (result.status !== "ok") {
                return false;
              }
              current = result.entries;
            }
            const preference = current
              ? decodeIdentityPreferences(current)[agentId]
              : loadNewSessionPreference(gatewayUrl, agentId);
            const match = matchSubmitted(preference);
            if (match !== "match") {
              return match === "superseded";
            }
            let next = { ...preference, ...nextPatch };
            if (current && client) {
              const entries = encodeIdentityPreferences({ [agentId]: next });
              const result = await saveUserPreferences(client, {
                entries,
                expectedEntries: Object.fromEntries(
                  Object.keys(entries).map((key) => [key, current[key] ?? null]),
                ),
              });
              // Route disposal cannot undo a committed value. Surviving projections
              // receive it without adopting another draft’s unsubmitted choices.
              // Uncommitted retries still belong to the initiating draft.
              if (!ownsConnection() || (result.status !== "ok" && !isCurrent())) {
                return undefined;
              }
              if (result.status === "conflict") {
                continue;
              }
              if (result.status !== "ok") {
                return false;
              }
              replaceBrowserPreference(gatewayUrl, agentId, next);
            } else {
              if (!replaceBrowserPreference(gatewayUrl, agentId, next)) {
                return false;
              }
              next = loadNewSessionPreference(gatewayUrl, agentId) ?? {};
            }
            writes.revision = {};
            for (const listener of writes.listeners) {
              listener(agentId, next, accepted);
            }
            if (current && this.preferenceScope === scope) {
              this.identityPreferences = { ...this.identityPreferences, [agentId]: next };
              this.callbacks.requestUpdate();
            }
            return true;
          }
          return false;
        } catch {
          return false;
        }
      };
      // Local storage is synchronous; Gateway writes outlive the submitting route.
      const pending = queued ? writer.write.then(write, write) : write();
      writer.write = pending.then((confirmed) => {
        if (confirmed === false && isCurrent()) {
          showToast({
            message: t(
              accepted
                ? "newSession.worktreeNameClearUnconfirmed"
                : "newSession.preferenceSaveUnconfirmed",
            ),
          });
        }
      });
      return writer.write;
    };
  }

  private async loadIdentityPreferences(params: {
    client: NonNullable<ApplicationContext["gateway"]["snapshot"]["client"]>;
    gatewayUrl: string;
    scope: PreferenceScope;
    profileId: string;
  }): Promise<void> {
    const source = this.read().source;
    const writes = source ? this.preferenceWrites(source) : undefined;
    const revision = writes?.revision;
    let conflicts = 0;
    try {
      const { loadUserPreferences } = await import("../../app/user-prefs-request.ts");
      const readEntries = async () => {
        const result = await loadUserPreferences(params.client, params.profileId);
        if (result.status !== "ok") {
          throw new Error("User preferences unavailable");
        }
        return result.entries;
      };
      if (this.preferenceScope !== params.scope) {
        return;
      }
      let entries = await readEntries();
      const browserPreferences = loadBrowserPreferences(params.gatewayUrl);
      while (this.preferenceScope === params.scope) {
        if (writes?.revision !== revision) {
          return this.loadIdentityPreferences(params);
        }
        let preferences = decodeIdentityPreferences(entries);
        if (entries[PREFS_MIGRATION_KEY] !== true && conflicts < 3) {
          const missing = Object.fromEntries(
            Object.entries(browserPreferences).filter(
              ([agentId]) => !Object.hasOwn(preferences, agentId),
            ),
          );
          const imports = Object.entries(encodeIdentityPreferences(missing));
          const batch = Object.fromEntries(imports.slice(0, USER_PREFS_ENTRY_LIMIT - 1));
          if (imports.length < USER_PREFS_ENTRY_LIMIT) {
            batch[PREFS_MIGRATION_KEY] = true;
          }
          // Guard the marker even in batches that do not complete migration.
          const response = await saveUserPreferences(params.client, {
            entries: batch,
            expectedEntries: {
              ...Object.fromEntries(Object.keys(batch).map((key) => [key, entries[key] ?? null])),
              [PREFS_MIGRATION_KEY]: entries[PREFS_MIGRATION_KEY] ?? null,
            },
          }).catch(() => null);
          if (this.preferenceScope !== params.scope) {
            return;
          }
          if (response?.status === "conflict") {
            conflicts += 1;
            entries = await readEntries();
            continue;
          }
          if (response?.status === "ok") {
            entries = { ...entries, ...batch };
            continue;
          }
          if (conflicts === 0) {
            preferences = { ...browserPreferences, ...preferences };
          }
        }
        if (writes?.revision !== revision) {
          return this.loadIdentityPreferences(params);
        }
        this.identityPreferences = preferences;
        this.preferenceModeValue = "remote";
        for (const [agentId, preference] of Object.entries(preferences)) {
          replaceBrowserPreference(params.gatewayUrl, agentId, preference);
        }
        this.adoptPreferences();
        return;
      }
    } catch {
      if (this.preferenceScope === params.scope) {
        this.preferenceModeValue = conflicts > 0 ? "remote" : "local";
        this.callbacks.requestUpdate();
      }
    }
  }
}
