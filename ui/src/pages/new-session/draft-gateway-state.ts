import { initialState, Task, TaskStatus } from "@lit/task";
import type { ReactiveControllerHost } from "lit";
import type { ApplicationContext } from "../../app/context.ts";
import { hasOperatorWriteAccess } from "../../app/operator-access.ts";
import { t } from "../../i18n/index.ts";
import { registerNewSessionSetupEnglish } from "../../i18n/locales/en-new-session-setup.ts";
import { isGatewayMethodAdvertised } from "../../lib/gateway-methods.ts";
import { normalizeAgentId } from "../../lib/sessions/session-key.ts";
import * as catalog from "./catalog-target.ts";
import { CLOUD_PROFILE_RETRY_DELAYS_MS } from "./cloud-profile-discovery.ts";
import { requestPlaceCatalog } from "./cloud-target.ts";
import type { DraftCloudProfile, DraftEnvironment } from "./discovery.ts";
import {
  DraftPreferenceState,
  type SubmittedWorktreePreference,
} from "./draft-preference-state.ts";
import { discoverGatewayName } from "./gateway-name-discovery.ts";
import type { NewSessionRouteData } from "./location.ts";
import {
  acquirePaletteIdentityPreferences,
  type PaletteIdentityPreferences,
} from "./palette-identity-preferences.ts";
import type { NewSessionPreference, PaletteSessionPreference } from "./preferences.ts";
import {
  resolveSubmissionOutcomeReason,
  type SubmissionOutcomeReason,
} from "./session-placement-recovery-state.ts";

registerNewSessionSetupEnglish();

const CATALOG_RETRY_DELAYS_MS = [0, 1_000, 3_000] as const;

type DraftGatewaySnapshot = Readonly<{
  context: ApplicationContext | undefined;
  data: NewSessionRouteData | undefined;
  isConnected: boolean;
  isAdmin: boolean;
  canStartAsDraft: boolean;
  visibility: "normal" | "draft" | "incognito";
  cloudProfileId: string;
  pendingPlacement: Readonly<{
    sessionKey: string;
    gatewayUrl: string;
    recoveryScope: string;
  }>;
  agentsHydrated: boolean;
  runtimeId: string;
}>;

export type DraftPreferenceOptions = {
  preferenceScope?: "palette";
  readPalettePreference?: () => PaletteSessionPreference | null;
};

type DraftGatewayCallbacks = DraftPreferenceOptions & {
  requestUpdate: () => void;
  updateComplete: () => Promise<unknown>;
  onInvalidate: (resetHostSelection: boolean, outcome: SubmissionOutcomeReason) => void;
  onVisibilityRetired: () => void;
  onCloudProfileCleared: () => void;
  onCloudState: (error: string | null) => void;
  onPendingPlacementReset: () => void;
  onRecoveryReady: (gatewayUrl: string, recoveryScope: string) => void;
  onAdoptAgentDefaults: () => void;
};

export class DraftGatewayState {
  private cloudProfilesValue: DraftCloudProfile[] = [];
  private requiredProfileValue: string | undefined;
  private environmentsValue: DraftEnvironment[] | null = null;
  private cloudProfilesReadyValue = false;
  private catalogRetryingValue = false;
  private catalogRevalidationPending = false;
  private gatewaySource: ApplicationContext["gateway"] | null = null;
  private gatewayClientValue: ApplicationContext["gateway"]["snapshot"]["client"] = null;
  private gatewayUrlValue = "";
  private gatewayBootIdValue = "";
  private gatewayRecoveryScopeValue = "";
  private gatewayRecoveryScopeReady = false;
  private gatewayConnectedValue = false;
  private gatewayConnectionEpochValue = 0;
  private catalogRetryScope = "";
  private catalogRetryAttempt = 0;
  private catalogRetryTimer: ReturnType<typeof globalThis.setTimeout> | undefined;
  private cloudProfileRetryAttempt = 0;
  private cloudProfileRefresh: Promise<void> | null = null;
  private cloudProfileRetryTimer: ReturnType<typeof globalThis.setTimeout> | undefined;
  private readonly preferences: DraftPreferenceState;
  private identityPreferences: PaletteIdentityPreferences | undefined;
  private stopPreferences: (() => void) | undefined;

  private readonly gatewayNameTask: Task<readonly unknown[], string>;
  private readonly cloudProfileTask: Task<
    readonly unknown[],
    Awaited<ReturnType<typeof requestPlaceCatalog>>
  >;

  constructor(
    host: ReactiveControllerHost,
    private readonly read: () => DraftGatewaySnapshot,
    private readonly callbacks: DraftGatewayCallbacks,
  ) {
    this.preferences = new DraftPreferenceState(
      () => ({
        source: this.gatewaySource,
        client: this.gatewayClientValue,
        gatewayUrl: this.gatewayUrlValue,
        recoveryScope: this.gatewayRecoveryScopeValue,
        bootId: this.gatewayBootIdValue,
        connected: this.gatewayConnectedValue,
        connectionEpoch: this.gatewayConnectionEpochValue,
        data: this.read().data,
        pendingPlacementSessionKey: this.read().pendingPlacement.sessionKey,
        agentsHydrated: this.read().agentsHydrated,
      }),
      callbacks,
    );
    this.gatewayNameTask = new Task(host, {
      args: () =>
        [
          this.read().isConnected && this.gatewayConnectedValue ? this.gatewayClientValue : null,
          isGatewayMethodAdvertised(this.read().context?.gateway.snapshot ?? {}, "system.info") ===
            true,
          this.gatewayConnectionEpochValue,
        ] as const,
      task: ([client, advertised, _connectionEpoch], { signal }) =>
        discoverGatewayName(client, advertised, signal),
    });
    this.cloudProfileTask = new Task(host, {
      args: () =>
        [
          this.read().isConnected && this.gatewayConnectedValue ? this.gatewayClientValue : null,
          this.gatewayConnectionEpochValue,
          hasOperatorWriteAccess(this.read().context?.gateway.snapshot.hello?.auth ?? null),
          this.read().isAdmin,
          this.gatewayRecoveryScopeValue,
          this.read().runtimeId,
        ] as const,
      task: async ([client, _connectionEpoch, _canWrite, isAdmin, _recoveryScope, runtimeId]) => {
        if (!client) {
          return initialState;
        }
        const result = await requestPlaceCatalog(client, runtimeId);
        return {
          ...result,
          profiles: isAdmin
            ? result.profiles
            : result.profiles.filter((profile) => profile.id === result.requiredProfile),
        };
      },
      onComplete: (placeCatalog) => {
        this.resetCloudProfileRetry();
        this.requiredProfileValue = placeCatalog.requiredProfile;
        this.environmentsValue = placeCatalog.environments;
        this.applyCloudProfiles(placeCatalog.profiles);
        this.cloudProfilesReadyValue = true;
      },
      onError: () => {
        // A failed refresh cannot invalidate this Gateway's last successful place catalog.
        this.scheduleCloudProfileRetry();
      },
    });
  }

  get gatewayName(): string {
    // Recovery-scope discovery does not retire this connection's machine identity.
    return this.gatewayNameTask.status === TaskStatus.COMPLETE
      ? (this.gatewayNameTask.value ?? "")
      : "";
  }

  get cloudProfiles(): readonly DraftCloudProfile[] {
    return this.cloudProfilesValue;
  }

  get requiredProfile(): string | undefined {
    return this.requiredProfileValue;
  }

  get placementPolicyReady(): boolean {
    return (
      this.cloudProfilesReadyValue &&
      (!this.requiredProfileValue || this.cloudProfileTask.status === TaskStatus.COMPLETE)
    );
  }

  get environments(): readonly DraftEnvironment[] | null {
    return this.environmentsValue;
  }

  get cloudProfilesReady(): boolean {
    return this.cloudProfilesReadyValue;
  }

  get cloudProfilesPending(): boolean {
    return this.cloudProfileTask.status === TaskStatus.PENDING;
  }

  get deviceCatalogDisabledReason(): string | undefined {
    // Cached cloud profiles survive refresh failures; live node capacity does not.
    return this.cloudProfilesReadyValue && this.cloudProfileTask.status === TaskStatus.COMPLETE
      ? undefined
      : t("newSession.placementNotReady");
  }

  get catalogRetrying(): boolean {
    return this.catalogRetryingValue;
  }

  get client(): ApplicationContext["gateway"]["snapshot"]["client"] {
    return this.gatewayClientValue;
  }

  get gatewayUrl(): string {
    return this.gatewayUrlValue;
  }

  get recoveryScope(): string {
    return this.gatewayRecoveryScopeValue;
  }

  get sessionCreateScope(): string {
    const scope = [this.gatewayUrlValue, this.gatewayRecoveryScopeValue, this.gatewayBootIdValue];
    return scope.every(Boolean) ? JSON.stringify(scope) : "";
  }

  get connected(): boolean {
    return this.gatewayConnectedValue;
  }

  get connectionEpoch(): number {
    return this.gatewayConnectionEpochValue;
  }

  get preferenceLoading(): boolean {
    return this.preferences.loading || this.identityPreferences?.mode === "loading";
  }

  resolvedGroupCategory(): string | undefined {
    const snapshot = this.read();
    return isGatewayMethodAdvertised(
      snapshot.context?.gateway.snapshot ?? {},
      "sessions.groups.defaults",
    ) === true
      ? catalog.resolvedGroupName(snapshot.data, snapshot.context?.sessions)
      : undefined;
  }

  refreshCloudProfiles(): Promise<void> {
    if (this.cloudProfileTask.status === TaskStatus.PENDING) {
      const queued =
        this.cloudProfileRefresh ??
        this.cloudProfileTask.taskComplete
          .catch(() => undefined)
          .then(() => {
            if (this.cloudProfileRefresh === queued) {
              this.cloudProfileRefresh = null;
              return this.refreshCloudProfiles();
            }
            return undefined;
          });
      this.cloudProfileRefresh = queued;
      return queued;
    }
    globalThis.clearTimeout(this.cloudProfileRetryTimer);
    this.cloudProfileRetryTimer = undefined;
    return this.cloudProfileTask.run();
  }

  synchronize(gateway: ApplicationContext["gateway"]) {
    const snapshot = gateway.snapshot;
    const connected = snapshot.phase === "connected";
    const firstBind = this.gatewaySource === null;
    // The Gateway's idempotency ledger is process-local; a new boot cannot safely replay a start.
    const bootId = connected
      ? (snapshot.hello?.server?.bootId?.trim() ?? "")
      : this.gatewayBootIdValue;
    const gatewayBootChanged =
      !firstBind &&
      connected &&
      Boolean(this.gatewayBootIdValue) &&
      bootId !== this.gatewayBootIdValue;
    const gatewayUrlChanged = !firstBind && this.gatewayUrlValue !== gateway.connection.gatewayUrl;
    const gatewaySourceChanged = !firstBind && this.gatewaySource !== gateway;
    const identityChanged =
      !firstBind && (gatewaySourceChanged || this.gatewayClientValue !== snapshot.client);
    const connectionChanged = !firstBind && this.gatewayConnectedValue !== connected;
    const becameConnected = connected && (identityChanged || !this.gatewayConnectedValue);
    const recoveryScopeBecameReady =
      connected && snapshot.client?.recoveryScopeReady === true && !this.gatewayRecoveryScopeReady;
    // Hello owns authentication; browser recovery migration may finish later.
    // Delaying this binding revokes live starts and lets reconnects replay under the old scope.
    const recoveryScope = connected
      ? (snapshot.hello?.auth?.recoveryScope ?? "")
      : this.gatewayRecoveryScopeValue;
    const recoveryScopeChanged = !firstBind && this.gatewayRecoveryScopeValue !== recoveryScope;
    this.gatewaySource = gateway;
    this.gatewayClientValue = snapshot.client;
    this.gatewayUrlValue = gateway.connection.gatewayUrl;
    this.gatewayBootIdValue = bootId;
    this.gatewayRecoveryScopeValue = recoveryScope;
    this.gatewayRecoveryScopeReady = snapshot.client?.recoveryScopeReady === true;
    this.gatewayConnectedValue = connected;
    if (this.read().visibility === "draft" && !this.read().canStartAsDraft) {
      this.callbacks.onVisibilityRetired();
    }
    if (
      gatewayUrlChanged ||
      gatewayBootChanged ||
      identityChanged ||
      connectionChanged ||
      recoveryScopeChanged
    ) {
      const ownerChanged = gatewaySourceChanged || gatewayUrlChanged || recoveryScopeChanged;
      const gatewayIdentityChanged = gatewayUrlChanged || recoveryScopeChanged;
      this.invalidateDiscovery(
        ownerChanged,
        resolveSubmissionOutcomeReason({
          gatewayIdentityChanged,
          placementDraftOwned: Boolean(this.read().pendingPlacement.sessionKey),
        }),
      );
    }
    if (
      firstBind ||
      gatewayUrlChanged ||
      recoveryScopeChanged ||
      recoveryScopeBecameReady ||
      becameConnected
    ) {
      const pending = this.read().pendingPlacement;
      if (
        pending.gatewayUrl &&
        (pending.gatewayUrl !== this.gatewayUrlValue ||
          pending.recoveryScope !== this.gatewayRecoveryScopeValue)
      ) {
        this.callbacks.onPendingPlacementReset();
      }
      if (connected && snapshot.client?.recoveryScopeReady) {
        this.callbacks.onRecoveryReady(this.gatewayUrlValue, this.gatewayRecoveryScopeValue);
      }
    }
    if (becameConnected) {
      this.gatewayConnectionEpochValue += 1;
      if (!firstBind && this.read().data?.startTerminal) {
        this.handleCatalogRetry();
      } else {
        this.retryPendingCatalogTarget();
      }
    }
    this.preferences.synchronize();
    this.synchronizeIdentityPreferences(snapshot.selfUser?.id);
    this.callbacks.requestUpdate();
  }

  invalidateDiscovery(resetHostSelection: boolean, submissionOutcome: SubmissionOutcomeReason) {
    this.cloudProfileRefresh = null;
    // Retire pending results synchronously; Lit may not run hostUpdate before they settle.
    void this.cloudProfileTask.run([null, -1, false, false, ""]);
    this.cloudProfilesValue = [];
    this.requiredProfileValue = undefined;
    this.cloudProfilesReadyValue = false;
    if (resetHostSelection) {
      this.environmentsValue = null;
    }
    this.resetCloudProfileRetry();
    this.callbacks.onInvalidate(resetHostSelection, submissionOutcome);
    this.callbacks.requestUpdate();
  }

  retryPendingCatalogTarget() {
    const { context, data } = this.read();
    if (this.catalogRetryingValue) {
      return;
    }
    if (data?.group && context?.sessions.groupsStatus() === "loading") {
      globalThis.clearTimeout(this.catalogRetryTimer);
      this.catalogRetryTimer = undefined;
      return;
    }
    if (!this.gatewayConnectedValue || !catalog.isRoutePending(data, context?.sessions)) {
      globalThis.clearTimeout(this.catalogRetryTimer);
      this.catalogRetryTimer = undefined;
      this.catalogRetryScope = "";
      this.catalogRetryAttempt = 0;
      return;
    }
    const retryScope = `${this.gatewayConnectionEpochValue}:${catalog.routeKey(data)}`;
    if (this.catalogRetryScope !== retryScope) {
      globalThis.clearTimeout(this.catalogRetryTimer);
      this.catalogRetryTimer = undefined;
      this.catalogRetryScope = retryScope;
      this.catalogRetryAttempt = 0;
    }
    if (this.catalogRetryTimer || this.catalogRetryAttempt >= CATALOG_RETRY_DELAYS_MS.length) {
      return;
    }
    const delayMs = CATALOG_RETRY_DELAYS_MS[this.catalogRetryAttempt];
    this.catalogRetryAttempt += 1;
    this.catalogRetryTimer = globalThis.setTimeout(() => {
      this.catalogRetryTimer = undefined;
      const current = this.read();
      if (
        this.catalogRetryScope !== retryScope ||
        !this.gatewayConnectedValue ||
        (current.data?.group && current.context?.sessions.groupsStatus() === "loading") ||
        !catalog.isRoutePending(current.data, current.context?.sessions)
      ) {
        return;
      }
      if (current.data?.group) {
        current.context?.sessions.groupsInvalidate();
      }
      const revalidation = current.context?.revalidate("new-session");
      if (!revalidation) {
        return;
      }
      void revalidation
        .catch(() => undefined)
        .then(() => this.callbacks.updateComplete())
        .then(() => this.retryPendingCatalogTarget());
    }, delayMs);
  }

  readonly handleCatalogRetry = () => {
    const { context, data } = this.read();
    if (
      !this.gatewayConnectedValue ||
      (data?.group && context?.sessions.groupsStatus() === "loading") ||
      (!data?.startTerminal && !catalog.isRoutePending(data, context?.sessions))
    ) {
      return;
    }
    if (this.catalogRetryingValue) {
      this.catalogRevalidationPending = true;
      return;
    }
    if (data?.group) {
      context?.sessions.groupsInvalidate();
    }
    const revalidation = context?.revalidate("new-session");
    if (!revalidation) {
      return;
    }
    globalThis.clearTimeout(this.catalogRetryTimer);
    this.catalogRetryTimer = undefined;
    this.catalogRetryingValue = true;
    this.callbacks.requestUpdate();
    void revalidation
      .catch(() => undefined)
      .then(() => this.callbacks.updateComplete())
      .finally(() => {
        this.catalogRetryingValue = false;
        if (this.catalogRevalidationPending) {
          this.catalogRevalidationPending = false;
          this.handleCatalogRetry();
        } else {
          this.retryPendingCatalogTarget();
        }
        this.callbacks.requestUpdate();
      });
  };

  get preferenceState(): PaletteIdentityPreferences | undefined {
    return this.identityPreferences;
  }

  savePalettePreference(preference: PaletteSessionPreference | null): Promise<boolean> {
    const state = this.identityPreferences;
    const snapshot = this.read().context?.gateway.snapshot;
    const client = snapshot?.client;
    const hello = snapshot?.hello;
    const profileId = snapshot?.selfUser?.id;
    const gatewayUrl = this.gatewayUrlValue;
    return (
      state?.setPalettePreference(
        preference,
        () =>
          this.identityPreferences === state &&
          this.gatewayConnectedValue &&
          this.read().context?.gateway.snapshot.client === client &&
          this.read().context?.gateway.snapshot.hello === hello &&
          this.read().context?.gateway.snapshot.selfUser?.id === profileId &&
          this.read().context?.gateway.connection.gatewayUrl === gatewayUrl,
      ) ?? Promise.resolve(false)
    );
  }

  readPreference(agentId: string): NewSessionPreference | null {
    const snapshot = this.read();
    if (
      catalog.isTarget(snapshot.data) ||
      snapshot.data?.group ||
      snapshot.pendingPlacement.sessionKey
    ) {
      return null;
    }
    const ordinary = this.preferences.readPreference(agentId);
    if (this.callbacks.preferenceScope !== "palette") {
      return ordinary;
    }
    const palette = this.callbacks.readPalettePreference?.();
    // Name is one-use input belonging to the foreground draft, not a default
    // the lightweight launcher can silently borrow or consume.
    return {
      ...ordinary,
      ...(palette?.agentId === normalizeAgentId(agentId) ? palette.selection : {}),
      worktreeName: "",
    };
  }

  capturePreferenceConsumption(
    agentId: string,
    workspace: string,
    expected: SubmittedWorktreePreference,
  ) {
    if (this.callbacks.preferenceScope === "palette") {
      return undefined;
    }
    return this.preferences.capturePreferenceConsumption(agentId, workspace, expected);
  }

  persistPreference(agentId: string, workspace: string, patch: NewSessionPreference) {
    if (this.callbacks.preferenceScope === "palette") {
      return;
    }
    return this.preferences.persistPreference(agentId, workspace, patch);
  }

  disconnect() {
    this.preferences.disconnect();
    this.stopPreferences?.();
    this.stopPreferences = undefined;
    this.identityPreferences = undefined;
    this.cloudProfilesValue = [];
    this.requiredProfileValue = undefined;
    this.cloudProfilesReadyValue = false;
    this.environmentsValue = null;
    this.cloudProfileRefresh = null;
    this.gatewaySource = null;
    this.gatewayClientValue = null;
    this.gatewayConnectedValue = false;
    this.gatewayConnectionEpochValue = 0;
    this.catalogRetryScope = "";
    this.catalogRetryAttempt = 0;
    globalThis.clearTimeout(this.catalogRetryTimer);
    this.catalogRetryTimer = undefined;
    void this.gatewayNameTask.run([null, false, -1]);
    void this.cloudProfileTask.run([null, -1, false, false, ""]);
    this.resetCloudProfileRetry();
  }

  private applyCloudProfiles(profiles: DraftCloudProfile[]) {
    const recoveryUnsupported = profiles.length > 0 && !this.gatewayRecoveryScopeValue;
    this.cloudProfilesValue = recoveryUnsupported ? [] : profiles;
    const snapshot = this.read();
    const pendingPlacement = Boolean(snapshot.pendingPlacement.sessionKey);
    const canWrite = hasOperatorWriteAccess(snapshot.context?.gateway.snapshot.hello?.auth ?? null);
    if ((!this.gatewayConnectedValue || !canWrite) && !pendingPlacement) {
      this.callbacks.onCloudProfileCleared();
    }
    const selectionUnavailable =
      !pendingPlacement &&
      Boolean(snapshot.cloudProfileId) &&
      !profiles.some((profile) => profile.id === snapshot.cloudProfileId);
    if (selectionUnavailable) {
      this.callbacks.onCloudState(t("newSession.catalogUnavailable"));
    } else if (recoveryUnsupported) {
      this.callbacks.onCloudState(t("newSession.cloudRecoveryUnavailable"));
    } else {
      this.callbacks.onCloudState(null);
    }
  }

  private resetCloudProfileRetry() {
    globalThis.clearTimeout(this.cloudProfileRetryTimer);
    this.cloudProfileRetryTimer = undefined;
    this.cloudProfileRetryAttempt = 0;
  }

  private scheduleCloudProfileRetry() {
    if (this.cloudProfileRetryTimer || !this.gatewayConnectedValue || !this.gatewayClientValue) {
      return;
    }
    if (this.cloudProfileRetryAttempt >= CLOUD_PROFILE_RETRY_DELAYS_MS.length) {
      // Unknown policy is not an optional empty catalog: keep new starts closed.
      return;
    }
    const delayMs = CLOUD_PROFILE_RETRY_DELAYS_MS[this.cloudProfileRetryAttempt];
    this.cloudProfileRetryAttempt += 1;
    this.cloudProfileRetryTimer = globalThis.setTimeout(() => {
      this.cloudProfileRetryTimer = undefined;
      if (this.gatewayConnectedValue) {
        void this.cloudProfileTask.run();
      }
    }, delayMs);
  }

  private synchronizeIdentityPreferences(profileId: string | undefined) {
    const client = this.gatewayConnectedValue ? this.gatewayClientValue : null;
    const context = this.read().context;
    const hello = context?.gateway.snapshot.hello;
    const advertised =
      context &&
      isGatewayMethodAdvertised(context.gateway.snapshot, "users.prefs.get") === true &&
      isGatewayMethodAdvertised(context.gateway.snapshot, "users.prefs.set") === true;
    const preferences =
      this.callbacks.preferenceScope === "palette" && client && hello && profileId && advertised
        ? acquirePaletteIdentityPreferences({
            client,
            hello,
            profileId,
            gatewayUrl: this.gatewayUrlValue,
          })
        : undefined;
    if (preferences === this.identityPreferences) {
      return;
    }
    this.stopPreferences?.();
    this.stopPreferences = undefined;
    this.identityPreferences = preferences;
    if (!preferences) {
      return;
    }
    const notify = () => {
      if (this.identityPreferences !== preferences) {
        return;
      }
      this.callbacks.requestUpdate();
    };
    this.stopPreferences = preferences.subscribe(
      notify,
      () =>
        this.identityPreferences === preferences &&
        this.gatewayConnectedValue &&
        this.read().context?.gateway.snapshot.client === client &&
        this.read().context?.gateway.snapshot.hello === hello &&
        this.read().context?.gateway.connection.gatewayUrl === this.gatewayUrlValue,
    );
    if (preferences.mode !== "loading") {
      notify();
    }
  }
}
