import type { ReactiveControllerHost } from "lit";
import { registerControlUiReloadGuard } from "../../app/document-reload-guard.ts";
import { createGatewayControlUiReloadOptions } from "../../app/gateway-control-ui-reload.ts";
import { retryStaleChunkReloadWhenReachable } from "../../app/stale-chunk-reload.ts";
import { readPresenceEntries } from "../../app/user-profile.ts";
import { t } from "../../i18n/index.ts";
import { showToast } from "../../lib/toast.ts";
import { SubscriptionsController } from "../../lit/subscriptions-controller.ts";
import { reviewPrivateComposerDraft } from "../chat/components/private-composer-recovery-dialog.ts";
import { isTarget as isCatalogTarget } from "./catalog-target.ts";
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
  private privateDraftReview: { controller: AbortController; isCurrent: () => boolean } | undefined;
  private readonly subscriptions: SubscriptionsController;
  private modelDefaultsPolicy: "last-used" | "configured" | null | undefined;

  private protectPrivateDraftFromReload() {
    const hasDraft = () =>
      this.submission.visibility === "incognito" &&
      Boolean(
        this.submission.message ||
        this.submission.mentions.length ||
        this.submission.attachmentDraft.attachments.length ||
        this.submission.attachmentDraft.pendingReads,
      );
    const showBlocked = (changed = false) =>
      showToast({
        message: t(changed ? "chat.privateDraftReload.changed" : "chat.privateDraftReload.blocked"),
        actionLabel: t("chat.privateDraftReload.review"),
        onAction: () => void review(),
      });
    const review = async () => {
      const context = this.read().context;
      if (!context || !this.read().isConnected || !hasDraft() || this.privateDraftReview) {
        return;
      }
      const controller = new AbortController();
      const client = context.gateway.snapshot.client;
      const connection = context.gateway.connection;
      const message = this.submission.message;
      const mentions = this.submission.mentions;
      const attachments = [...this.submission.attachmentDraft.attachments];
      const pendingReads = this.submission.attachmentDraft.pendingReads;
      const currentOwner = () =>
        !controller.signal.aborted &&
        this.read().isConnected &&
        this.read().context === context &&
        context.gateway.snapshot.client === client &&
        context.gateway.connection === connection;
      const current = () =>
        currentOwner() &&
        this.submission.visibility === "incognito" &&
        this.submission.message === message &&
        this.submission.mentions === mentions &&
        this.submission.attachmentDraft.pendingReads === pendingReads &&
        this.submission.attachmentDraft.attachments.length === attachments.length &&
        attachments.every(
          (attachment, index) => this.submission.attachmentDraft.attachments[index] === attachment,
        );
      this.privateDraftReview = { controller, isCurrent: current };
      const reloadOptions = createGatewayControlUiReloadOptions(context.gateway);
      try {
        const discard = await reviewPrivateComposerDraft({
          text: message,
          attachments,
          hasGoal: false,
          pendingReads,
          isCurrent: current,
          signal: controller.signal,
        });
        if (!current()) {
          if (currentOwner() && hasDraft()) {
            showBlocked(true);
          }
          return;
        }
        if (!discard) {
          return;
        }
        this.submission.attachmentDraft.reset({ release: true });
        this.submission.setMessage("", []);
        await retryStaleChunkReloadWhenReachable({ timeoutMs: 0, ...reloadOptions });
      } catch {
        if (currentOwner()) {
          showToast({ message: t("chat.privateDraftReload.unavailable") });
        }
      } finally {
        if (this.privateDraftReview?.controller === controller) {
          this.privateDraftReview = undefined;
        }
        if (
          controller.signal.reason === "draft-changed" &&
          this.read().isConnected &&
          this.read().context === context &&
          context.gateway.connection === connection &&
          context.gateway.snapshot.client === client &&
          hasDraft()
        ) {
          showBlocked(true);
        }
      }
    };
    const unregister = registerControlUiReloadGuard(
      () => !hasDraft(),
      () => showBlocked(),
    );
    return () => {
      unregister();
      this.privateDraftReview?.controller.abort();
    };
  }

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
    const requestUpdate = () => {
      if (this.privateDraftReview && !this.privateDraftReview.isCurrent()) {
        this.privateDraftReview.controller.abort("draft-changed");
      }
      callbacks.requestUpdate();
    };
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
    this.submission = new DraftSubmissionFlow(this.gateway, this.place, read, {
      ...callbacks,
      requestUpdate,
    });
    this.submission.draftPersistence.modelSelection = {
      read: () =>
        read().context?.config?.current.newSessionModelDefaults === "configured"
          ? this.place.modelControl.draftSelection(this.place.agentId)
          : undefined,
      restore: (selection) => this.place.modelControl.restoreDraftSelection(selection),
      retire: () => {
        if (read().context?.config?.current.newSessionModelDefaults === "configured") {
          this.place.modelControl.retireDraftSelection();
        }
      },
    };
    this.place.modelControl.onDraftSelectionChange = () => {
      if (read().context?.config?.current.newSessionModelDefaults === "configured") {
        this.submission.draftPersistence.noteModelSelectionMutation();
      }
    };
    this.subscriptions = new SubscriptionsController(host)
      .effect(
        () => this.read().context,
        () => this.protectPrivateDraftFromReload(),
      )
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
      !agents.agentsListCached &&
      this.place.agents().length > 0,
    );
  }

  synchronizeSelections() {
    const modelDefaultsPolicy = this.read().context?.config?.current.newSessionModelDefaults;
    if (!this.place.agentsHydrated && this.agentsReady()) {
      this.place.setAgentsHydrated(true);
      this.place.adoptAgentDefaults({ preserveSelectedAgent: true, preserveSelectedFolder: true });
    } else if (this.place.agentsHydrated && modelDefaultsPolicy !== this.modelDefaultsPolicy) {
      const { context, data } = this.read();
      this.place.modelControl.load(context, this.place.agentId, !isCatalogTarget(data), {
        agent: this.place.selectedAgent(),
        preference: this.gateway.readPreference(this.place.agentId),
        configuredDefaults: this.place.requiredWorkerInference,
      });
    }
    if (
      modelDefaultsPolicy === "configured" &&
      this.modelDefaultsPolicy !== "configured" &&
      !this.submission.submitting &&
      this.place.modelControl.draftSelection(this.place.agentId)
    ) {
      this.submission.draftPersistence.noteModelSelectionMutation();
    }
    this.modelDefaultsPolicy = modelDefaultsPolicy;
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
