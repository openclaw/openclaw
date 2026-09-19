import type { ReactiveControllerHost } from "lit";
import { readPresenceEntries } from "../../app/user-profile.ts";
import { SubscriptionsController } from "../../lit/subscriptions-controller.ts";
import { DraftGatewayState, type DraftPreferenceOptions } from "./draft-gateway-state.ts";
import { DraftPlaceBrowser } from "./draft-place-browser.ts";
import { DraftPlaceState } from "./draft-place-state.ts";
import type {
  DraftSubmissionCallbacks,
  DraftSubmissionSnapshot,
} from "./draft-submission-contract.ts";
import { DraftSubmissionFlow } from "./draft-submission-flow.ts";
import { isPlaceTopologyEvent, nodePresenceStateSignature } from "./new-session-runtime.ts";
import type { SubmissionOutcomeReason } from "./session-placement-recovery-state.ts";

/** Shared creation owners; route retention and draft restoration stay with each surface. */
export class NewSessionDraftController {
  readonly gateway: DraftGatewayState;
  readonly browser: DraftPlaceBrowser;
  readonly place: DraftPlaceState;
  readonly submission: DraftSubmissionFlow;
  private readonly subscriptions: SubscriptionsController;

  constructor(
    host: ReactiveControllerHost,
    private readonly read: () => DraftSubmissionSnapshot,
    callbacks: DraftSubmissionCallbacks &
      DraftPreferenceOptions & {
        querySelector: (selector: string) => Element | null;
        activeElement: () => Element | null;
        body: () => HTMLElement | null;
        onInvalidate: () => void;
        onRecoveryReady: (gatewayUrl: string, recoveryScope: string) => void;
        pickerIdPrefix?: string;
      },
  ) {
    const { requestUpdate } = callbacks;
    this.gateway = new DraftGatewayState(
      host,
      () => ({
        ...read(),
        isAdmin: this.place?.isAdmin() ?? false,
        canStartAsDraft: this.submission?.capabilities.canStartAsDraft(read().context) ?? false,
        visibility: this.submission?.visibility ?? "normal",
        cloudProfileId: this.place?.cloudProfileId ?? "",
        pendingPlacement: this.submission?.pendingPlacement ?? {
          sessionKey: "",
          gatewayUrl: "",
          recoveryScope: "",
        },
        agentsHydrated: this.place?.agentsHydrated ?? false,
        runtimeId: this.place?.devicePlacementRuntime()?.id ?? "",
      }),
      {
        preferenceScope: callbacks.preferenceScope,
        readPalettePreference: callbacks.readPalettePreference,
        requestUpdate,
        updateComplete: () => host.updateComplete,
        onInvalidate: (reset, outcome) => {
          this.invalidate(reset, outcome);
          callbacks.onInvalidate();
        },
        onVisibilityRetired: () => this.submission.setVisibility("normal"),
        onCloudProfileCleared: () => this.place.clearCloudProfile(),
        onCloudState: (error) => this.submission.setError(error),
        onPendingPlacementReset: () => this.submission.releasePendingPlacementOwner(),
        onRecoveryReady: callbacks.onRecoveryReady,
        onAdoptAgentDefaults: () =>
          this.place.adoptAgentDefaults({
            preserveSelectedAgent: true,
            preserveSelectedFolder: true,
          }),
      },
    );
    this.browser = new DraftPlaceBrowser(
      host,
      this.gateway,
      () => ({
        context: read().context,
        isAdmin: this.place?.isAdmin() ?? false,
      }),
      {
        requestUpdate,
        onProjectMissing: () => this.place.clearProjectSelection(),
        onSelectProject: (projectId) => this.place.selectProjectId(projectId),
        onApprovedListing: (listing) => this.place.recordGatewayApprovedListing(listing),
        querySelector: callbacks.querySelector,
        activeElement: callbacks.activeElement,
        body: callbacks.body,
        pickerIdPrefix: callbacks.pickerIdPrefix,
      },
    );
    this.place = new DraftPlaceState(
      this.gateway,
      this.browser,
      () => ({
        context: read().context,
        data: read().data,
        submitting: this.submission?.submitting ?? false,
        pendingPlacementSessionKey: this.submission?.pendingPlacement.sessionKey ?? "",
      }),
      {
        requestUpdate,
        onError: (error) =>
          error === null ? this.submission.clearError() : this.submission.setError(error),
        onClearError: (error) => this.submission.clearError(error),
      },
    );
    this.submission = new DraftSubmissionFlow(this.gateway, this.place, read, callbacks);
    this.subscriptions = new SubscriptionsController(host)
      .watch(
        () => this.read().context?.gateway,
        (gateway, notify) => gateway.subscribe(notify),
        (gateway) => this.gateway.synchronize(gateway),
      )
      .effect(
        () => this.read().context?.gateway,
        (gateway) => {
          let presence = nodePresenceStateSignature(
            readPresenceEntries(gateway.snapshot.hello?.snapshot) ?? [],
          );
          return gateway.subscribeEvents((event) => {
            if (this.read().context?.gateway !== gateway) {
              return;
            }
            const next = event.event === "presence" ? readPresenceEntries(event.payload) : null;
            const signature = next ? nodePresenceStateSignature(next) : presence;
            if (isPlaceTopologyEvent(event.event) || signature !== presence) {
              presence = signature;
              void this.gateway.refreshCloudProfiles();
              this.gateway.handleCatalogRetry();
            }
          });
        },
      );
  }

  agentsReady(): boolean {
    const agents = this.read().context?.agents.state;
    return Boolean(
      this.gateway.connected &&
      this.gateway.client &&
      agents?.connected &&
      agents.client === this.gateway.client &&
      this.place.agents().length > 0,
    );
  }

  synchronizeSelections() {
    if (!this.place.agentsHydrated && this.agentsReady()) {
      this.place.setAgentsHydrated(true);
      this.place.adoptAgentDefaults({ preserveSelectedAgent: true, preserveSelectedFolder: true });
    }
    this.place.restorePreferenceSelections();
    this.place.synchronizeTerminalHosts();
  }

  private invalidate(resetHostSelection: boolean, outcome: SubmissionOutcomeReason) {
    this.place.invalidateGatewayDiscovery(resetHostSelection);
    this.submission.attachmentDraft.abortReads();
    this.submission.invalidate(outcome);
    if (resetHostSelection && this.submission.pendingPlacement.sessionKey) {
      this.submission.markPendingPlacementUnavailable(outcome);
    }
    if (resetHostSelection) {
      this.submission.clearError();
    }
  }

  disconnect() {
    this.subscriptions.clear();
    this.gateway.invalidateDiscovery(
      true,
      this.submission.pendingPlacement.sessionKey ? "placement-interrupted" : "gateway-changed",
    );
    this.gateway.disconnect();
    this.browser.disconnect();
    this.submission.disconnect();
  }
}
