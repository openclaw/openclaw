import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import type {
  EnvironmentsListResult,
  EnvironmentsAdoptSuggestedProfileResult,
} from "../../../../packages/gateway-protocol/src/schema/environments.ts";
import { readOfflineStorageScope } from "../../app/boot-record.ts";
import type { ApplicationContext } from "../../app/context.ts";
import { hasOperatorWriteAccess } from "../../app/operator-access.ts";
import { t } from "../../i18n/index.ts";
import { registerNewSessionSetupEnglish } from "../../i18n/locales/en-new-session-setup.ts";
import { isGatewayMethodAdvertised } from "../../lib/gateway-methods.ts";
import { canReadSystemInfo, readSystemInfo } from "../../lib/system-info.ts";
import * as catalog from "./catalog-target.ts";
import { CLOUD_PROFILE_RETRY_DELAYS_MS } from "./cloud-profile-discovery.ts";
import { requestPlaceCatalog } from "./cloud-target.ts";
import type { DraftCloudProfile, DraftEnvironment } from "./discovery.ts";
import type { DraftGatewayCallbacks, DraftGatewaySnapshot } from "./draft-gateway-contract.ts";
import {
  DraftPreferenceState,
  type SubmittedWorktreePreference,
} from "./draft-preference-state.ts";
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

export class DraftGatewayState {
  static requiredPlacement(gateway: DraftGatewayState, data: NewSessionRouteData | undefined) {
    return Boolean(gateway.requiredProfile) && !catalog.isTarget(data);
  }

  private cloudProfilesValue: DraftCloudProfile[] = [];
  private suggestedProfileValue: EnvironmentsListResult["suggestedProfile"];
  private gatewayAuthorityValue = "";
  private environmentsValue: DraftEnvironment[] | null = null;
  private cloudProfilesReadyValue = false;
  private catalogRetryingValue = false;
  private catalogRevalidation: Promise<void> | undefined;
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

  private gatewayNameValue = "";
  private gatewayNameArgs: readonly unknown[] = [];
  private gatewayNameRequest: AbortController | undefined;
  private cloudProfileArgs: readonly unknown[] = [];
  private cloudProfileStatus: "initial" | "pending" | "complete" | "error" = "initial";
  private cloudProfileRequest: object | undefined;
  private cloudProfileComplete: Promise<void> = Promise.resolve();

  constructor(
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
  }

  synchronizeMetadata() {
    this.synchronizeGatewayName();
    this.synchronizeCloudProfiles();
  }

  private synchronizeGatewayName() {
    const gateway =
      this.read().isConnected && this.gatewayConnectedValue ? this.gatewaySource : null;
    const available =
      canReadSystemInfo(this.read().context?.gateway.snapshot) &&
      document.visibilityState !== "hidden";
    const args = [gateway, available, this.gatewayConnectionEpochValue];
    if (args.every((arg, index) => Object.is(arg, this.gatewayNameArgs[index]))) {
      return;
    }
    this.gatewayNameArgs = args;
    this.gatewayNameRequest?.abort();
    this.gatewayNameRequest = undefined;
    this.gatewayNameValue = "";
    if (!gateway || !available) {
      return;
    }
    const request = new AbortController();
    this.gatewayNameRequest = request;
    void readSystemInfo(gateway, request.signal, { fresh: true })
      .then(({ value: result }) => {
        if (!request.signal.aborted) {
          this.gatewayNameValue =
            normalizeOptionalString(result.machineName) ??
            normalizeOptionalString(result.hostname)?.split(".", 1)[0] ??
            "";
        }
      })
      .catch(() => undefined)
      .finally(() => {
        if (this.gatewayNameRequest === request) {
          this.gatewayNameRequest = undefined;
          this.callbacks.changed();
        }
      });
  }

  private cloudProfileInput() {
    return [
      this.read().isConnected && this.gatewayConnectedValue ? this.gatewayClientValue : null,
      this.gatewayConnectionEpochValue,
      hasOperatorWriteAccess(this.read().context?.gateway.snapshot.hello?.auth ?? null),
      this.read().isAdmin,
      this.gatewayRecoveryScopeValue,
      this.read().runtimeId,
      this.placementPolicy(),
    ] as const;
  }

  private synchronizeCloudProfiles() {
    const args = this.cloudProfileInput();
    if (!args.every((arg, index) => Object.is(arg, this.cloudProfileArgs[index]))) {
      void this.readCloudProfiles(args);
    }
  }

  private readCloudProfiles(args = this.cloudProfileInput()): Promise<void> {
    this.cloudProfileArgs = args;
    const [client, _connectionEpoch, canWrite, isAdmin, _recoveryScope, runtimeId, policy] = args;
    const request = {};
    this.cloudProfileRequest = request;
    this.cloudProfileStatus = client && policy ? "pending" : "initial";
    if (!client || !policy) {
      this.callbacks.changed();
      return Promise.resolve();
    }
    const required = policy.requiredProfile;
    const result =
      required || !canWrite
        ? Promise.resolve({
            profiles: required?.providerId
              ? [{ ...required, providerId: required.providerId }]
              : [],
            environments: [],
            suggestedProfile: undefined,
          })
        : requestPlaceCatalog(client, runtimeId).then((placeCatalog) => ({
            ...placeCatalog,
            profiles: isAdmin ? placeCatalog.profiles : [],
            suggestedProfile: isAdmin ? placeCatalog.suggestedProfile : undefined,
          }));
    this.cloudProfileComplete = result
      .then((placeCatalog) => {
        if (this.cloudProfileRequest !== request) {
          return;
        }
        this.cloudProfileStatus = "complete";
        this.resetCloudProfileRetry();
        this.environmentsValue = placeCatalog.environments;
        this.applyCloudProfiles(placeCatalog.profiles);
        this.suggestedProfileValue =
          placeCatalog.profiles.length === 0 ? placeCatalog.suggestedProfile : undefined;
        this.cloudProfilesReadyValue = true;
      })
      .catch(() => {
        if (this.cloudProfileRequest === request) {
          this.cloudProfileStatus = "error";
          // Keep this Gateway's last successful catalog while its retry is pending.
          this.scheduleCloudProfileRetry();
        }
      })
      .finally(() => {
        if (this.cloudProfileRequest === request) {
          this.callbacks.changed();
        }
      });
    this.callbacks.changed();
    return this.cloudProfileComplete;
  }

  private retireCloudProfiles() {
    this.cloudProfileRequest = undefined;
    this.cloudProfileArgs = [];
    this.cloudProfileStatus = "initial";
  }

  get gatewayName(): string {
    return this.gatewayNameValue;
  }

  get cloudProfiles(): readonly DraftCloudProfile[] {
    return this.cloudProfilesValue;
  }

  get suggestedProfile(): EnvironmentsListResult["suggestedProfile"] {
    return this.suggestedProfileValue;
  }

  async adoptSuggestedProfile(): Promise<string | undefined> {
    const client = this.gatewayClientValue;
    const epoch = this.gatewayConnectionEpochValue;
    const scope = this.sessionCreateScope;
    if (
      !client ||
      !this.gatewayConnectedValue ||
      !this.read().isAdmin ||
      !this.suggestedProfileValue
    ) {
      return undefined;
    }
    const { profile } = await client.request<EnvironmentsAdoptSuggestedProfileResult>(
      "environments.adoptSuggestedProfile",
      {},
    );
    if (
      client !== this.gatewayClientValue ||
      epoch !== this.gatewayConnectionEpochValue ||
      scope !== this.sessionCreateScope ||
      !this.gatewayConnectedValue ||
      !this.read().isAdmin
    ) {
      return undefined;
    }
    // Retire an older catalog read before publishing the saved profile.
    void this.readCloudProfiles();
    this.applyCloudProfiles([profile]);
    this.suggestedProfileValue = undefined;
    this.callbacks.changed();
    return profile.id;
  }

  /** The agent roster carries the policy, so it needs no request or wait of its own. */
  private placementPolicy() {
    return this.callbacks.readAgents()?.state.agentsList?.sessionPlacement;
  }

  get requiredProfile(): string | undefined {
    return this.placementPolicy()?.requiredProfile?.id;
  }

  get placementPolicyReady(): boolean {
    const policy = this.placementPolicy();
    // Required starts need their profile applied before an accepted cold Send can resume.
    return policy !== undefined && (!policy.requiredProfile || this.cloudProfilesReadyValue);
  }

  get environments(): readonly DraftEnvironment[] | null {
    return this.environmentsValue;
  }

  get cloudProfilesReady(): boolean {
    return this.cloudProfilesReadyValue;
  }

  get cloudProfilesRead(): Promise<void> | undefined {
    return this.cloudProfileStatus === "initial" ? undefined : this.cloudProfileComplete;
  }

  get cloudProfilesPending(): boolean {
    return this.cloudProfileStatus === "pending";
  }

  get deviceCatalogDisabledReason(): string | undefined {
    // Cached cloud profiles survive refresh failures; live node capacity does not.
    return this.cloudProfilesReadyValue && this.cloudProfileStatus === "complete"
      ? undefined
      : t("newSession.placementNotReady");
  }

  get catalogRetrying(): boolean {
    return this.catalogRetryingValue;
  }

  get catalogRetryRead(): Promise<void> | undefined {
    return this.catalogRevalidation;
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

  refreshCloudProfiles(): Promise<void> {
    if (this.cloudProfileStatus === "pending") {
      const queued =
        this.cloudProfileRefresh ??
        this.cloudProfileComplete
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
    return this.readCloudProfiles();
  }

  /** A missing required worker is a policy fact, so Retry rereads the roster that owns it. */
  async retryRequiredPlacement(): Promise<void> {
    await this.callbacks.readAgents()?.refreshList();
    await this.refreshCloudProfiles();
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
    const authority = connected
      ? JSON.stringify([
          snapshot.selfUser?.id,
          snapshot.hello?.auth?.role,
          snapshot.hello?.auth?.scopes?.toSorted(),
        ])
      : this.gatewayAuthorityValue;
    const authorityChanged = !firstBind && this.gatewayAuthorityValue !== authority;
    const identityChanged =
      !firstBind &&
      (gatewaySourceChanged || this.gatewayClientValue !== snapshot.client || authorityChanged);
    const connectionChanged = !firstBind && this.gatewayConnectedValue !== connected;
    const becameConnected = connected && (identityChanged || !this.gatewayConnectedValue);
    const recoveryScopeBecameReady =
      connected && snapshot.client?.recoveryScopeReady === true && !this.gatewayRecoveryScopeReady;
    // Hello owns authentication; browser recovery migration may finish later.
    // Delaying this binding revokes live starts and lets reconnects replay under the old scope.
    const recoveryScope = connected
      ? (snapshot.hello?.auth?.recoveryScope ?? "")
      : (readOfflineStorageScope({ client: snapshot.client }) ?? "");
    const recoveryScopeChanged = !firstBind && this.gatewayRecoveryScopeValue !== recoveryScope;
    this.gatewayAuthorityValue = authority;
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
      const ownerChanged =
        gatewaySourceChanged || gatewayUrlChanged || recoveryScopeChanged || authorityChanged;
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
      if (recoveryScope && (!connected || snapshot.client?.recoveryScopeReady)) {
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
    this.callbacks.changed();
  }

  invalidateDiscovery(resetHostSelection: boolean, submissionOutcome: SubmissionOutcomeReason) {
    this.cloudProfileRefresh = null;
    // Retire pending results synchronously before the next render can observe them.
    this.retireCloudProfiles();
    this.cloudProfilesValue = [];
    this.suggestedProfileValue = undefined;
    this.cloudProfilesReadyValue = false;
    if (resetHostSelection) {
      this.environmentsValue = null;
    }
    this.resetCloudProfileRetry();
    this.callbacks.onInvalidate(resetHostSelection, submissionOutcome);
    this.callbacks.changed();
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
    // Readiness excludes updateComplete: rendering must not await its own completion.
    this.catalogRevalidation = revalidation;
    this.callbacks.changed();
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
        this.callbacks.changed();
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
    return this.preferences.readPreference(agentId);
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
    this.suggestedProfileValue = undefined;
    this.cloudProfilesReadyValue = false;
    this.environmentsValue = null;
    this.cloudProfileRefresh = null;
    this.gatewaySource = null;
    this.gatewayAuthorityValue = "";
    this.gatewayClientValue = null;
    this.gatewayConnectedValue = false;
    this.gatewayConnectionEpochValue = 0;
    this.catalogRetryScope = "";
    this.catalogRetryAttempt = 0;
    globalThis.clearTimeout(this.catalogRetryTimer);
    this.catalogRetryTimer = undefined;
    this.gatewayNameRequest?.abort();
    this.gatewayNameRequest = undefined;
    this.gatewayNameArgs = [];
    this.gatewayNameValue = "";
    this.retireCloudProfiles();
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
        void this.readCloudProfiles();
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
      this.callbacks.changed();
    };
    // The preference lease requires this live-authority predicate when publishing results.
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
