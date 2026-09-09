import { consume } from "@lit/context";
import { nothing } from "lit";
import { property } from "lit/decorators.js";
import { applicationContext, type ApplicationGatewaySnapshot } from "../../app/context.ts";
import "../../components/tooltip.ts";
import { t } from "../../i18n/index.ts";
import { readSessionMethodAccess } from "../../lib/session-method-access.ts";
import { sessionNavigationTarget } from "../../lib/sessions/route-navigation.ts";
import { generateUUID } from "../../lib/uuid.ts";
import { OpenClawLightDomElement } from "../../lit/openclaw-element.ts";
import { SubscriptionsController } from "../../lit/subscriptions-controller.ts";
import { buildInitialChatSubmission } from "../chat/user-message-content.ts";
import { retainRejectedInitialTurn } from "../new-session/rejected-initial-turn.ts";
import { canCallWorkshopAdminMethod } from "./access.ts";
import { SKILL_WORKSHOP_LEARNING_PROMPT } from "./learning-prompt.ts";
import type { SkillWorkshopRevisionRequest } from "./page-types.ts";
import { renderSkillWorkshopPage } from "./page-view.ts";
import {
  createSkillWorkshopState,
  loadSkillWorkshopProposals,
  resolveSkillWorkshopAgentId,
  requestSkillWorkshopRevision,
  runSkillWorkshopEvaluation,
  type SkillWorkshopRouteData,
  type SkillWorkshopState,
} from "./proposals.ts";
import {
  SkillWorkshopRevisionRecoveryController,
  skillWorkshopRevisionAdmissionsFor,
} from "./revision-recovery.ts";
import { resolveSelfLearning, setSelfLearningEnabled } from "./self-learning.ts";
import {
  captureSkillWorkshopSourceScope,
  isCurrentSkillWorkshopSourceScope,
  type SkillWorkshopPageContext,
  type SkillWorkshopSourceScope,
} from "./source-scope.ts";
import { loadSkillWorkshopMode } from "./storage.ts";

class SkillWorkshopPage extends OpenClawLightDomElement {
  @consume({ context: applicationContext, subscribe: true })
  private context?: SkillWorkshopPageContext;
  @property({ attribute: false }) data?: SkillWorkshopRouteData;

  private state?: SkillWorkshopState;
  private operationEpoch = 0;
  private hasBoundContext = false;
  private contextSource?: SkillWorkshopPageContext;
  private gatewaySource?: SkillWorkshopPageContext["gateway"];
  private gatewayClient: SkillWorkshopPageContext["gateway"]["snapshot"]["client"] = null;
  private gatewayHello: SkillWorkshopPageContext["gateway"]["snapshot"]["hello"] = null;
  private gatewayConnected = false;
  private hasBoundAgentSelection = false;
  private agentSelectionSource?: SkillWorkshopPageContext["agentSelection"];
  private selectedAgentId?: string | null;
  private hasBoundSessions = false;
  private sessionsSource?: SkillWorkshopPageContext["sessions"];
  private selfLearningBusy = false;
  private selfLearningError: string | null = null;
  private learningBusy = false;
  private learningError: string | null = null;
  private readonly requestPageUpdate = () => {
    if (this.isConnected) {
      this.requestUpdate();
    }
  };
  private readonly revisionRecovery = new SkillWorkshopRevisionRecoveryController(
    this.requestPageUpdate,
  );
  private readonly subscriptions = new SubscriptionsController(this)
    .watch(
      () => this.context?.agents,
      (agents, notify) => agents.subscribe(notify),
    )
    .effect(
      () => this.context,
      (context) => {
        const sourceChanged = this.hasBoundContext && this.contextSource !== context;
        this.hasBoundContext = true;
        this.contextSource = context;
        if (sourceChanged) {
          const gateway = context.gateway;
          this.gatewaySource = gateway;
          this.gatewayClient = gateway.snapshot.client;
          this.gatewayHello = gateway.snapshot.hello;
          this.gatewayConnected = gateway.snapshot.phase === "connected";
          this.agentSelectionSource = context.agentSelection;
          this.selectedAgentId = context.agentSelection.state.selectedId;
          this.sessionsSource = context.sessions;
          this.resetSourceState();
          this.loadProposals(true);
        }
      },
    )
    .effect(
      () => this.context?.gateway,
      (gateway) => {
        const snapshot = gateway.snapshot;
        const sourceChanged = this.gatewaySource !== undefined && this.gatewaySource !== gateway;
        const clientChanged =
          this.gatewaySource !== undefined && this.gatewayClient !== snapshot.client;
        const connectionChanged =
          this.gatewaySource !== undefined &&
          this.gatewayConnected !== (snapshot.phase === "connected");
        const helloChanged =
          this.gatewaySource !== undefined && this.gatewayHello !== snapshot.hello;
        this.applyGatewaySnapshot(
          gateway,
          snapshot,
          sourceChanged || clientChanged || connectionChanged || helloChanged,
        );
        const cleanup = gateway.subscribe((nextSnapshot) => {
          if (this.gatewaySource !== gateway || this.context?.gateway !== gateway) {
            return;
          }
          const sourceEpochChanged =
            nextSnapshot.client !== this.gatewayClient ||
            (nextSnapshot.phase === "connected") !== this.gatewayConnected ||
            nextSnapshot.hello !== this.gatewayHello;
          this.applyGatewaySnapshot(gateway, nextSnapshot, sourceEpochChanged);
        });
        return cleanup;
      },
    )
    .watch(
      () => this.context?.config,
      (config, notify) => config.subscribe(notify),
    )
    .effect(
      () => this.context?.agentSelection,
      (agentSelection) => {
        let resetForSourceBind =
          this.hasBoundAgentSelection && this.agentSelectionSource !== agentSelection;
        this.hasBoundAgentSelection = true;
        this.agentSelectionSource = agentSelection;
        let initialNotification = true;
        const handleChange = () => {
          if (
            this.agentSelectionSource !== agentSelection ||
            this.context?.agentSelection !== agentSelection
          ) {
            return;
          }
          const nextAgentId = agentSelection.state.selectedId;
          const agentChanged = !initialNotification && this.selectedAgentId !== nextAgentId;
          this.selectedAgentId = nextAgentId;
          const sourceEpochChanged = resetForSourceBind || agentChanged;
          resetForSourceBind = false;
          initialNotification = false;
          if (sourceEpochChanged) {
            this.resetSourceState();
          }
          this.loadProposals(sourceEpochChanged);
        };
        handleChange();
        return agentSelection.subscribe(handleChange);
      },
    )
    .effect(
      () => this.context?.sessions,
      (sessions) => {
        const sourceChanged = this.hasBoundSessions && this.sessionsSource !== sessions;
        this.hasBoundSessions = true;
        this.sessionsSource = sessions;
        if (sourceChanged) {
          this.resetSourceState();
          this.loadProposals(true);
        }
      },
    )
    .watch(
      () => this.context?.agentIdentity,
      (agentIdentity, notify) => agentIdentity.subscribe(notify),
    )
    .watch(
      () => this.context?.runtimeConfig,
      (runtimeConfig, notify) => runtimeConfig.subscribe(notify),
    )
    .watch(
      () => (this.context ? skillWorkshopRevisionAdmissionsFor(this.context) : undefined),
      (admissions, notify) => admissions.subscribe(notify),
    );

  private readonly handleRevisionRequest: SkillWorkshopRevisionRequest = async (
    instructions,
    proposal,
    proposalAgentId,
    expectedRevisionHash,
  ) => {
    const scope = this.captureSourceScope();
    if (!scope) {
      return {
        error: "Skill Workshop is not ready.",
        id: "unowned",
        status: "retryable-failed",
      };
    }
    return await this.revisionRecovery.request({
      context: scope.context,
      expectedRevisionHash,
      instructions,
      proposal,
      proposalAgentId,
    });
  };

  private readonly handleEvaluation = (proposalId: string) => {
    const scope = this.captureSourceScope();
    if (!scope) {
      return;
    }
    void runSkillWorkshopEvaluation(scope.state, scope.context, proposalId, () =>
      this.isCurrentSourceScope(scope),
    ).finally(this.requestPageUpdate);
  };

  private readonly handleRevisionSubmit = (proposalId: string) => {
    const scope = this.captureSourceScope();
    if (!scope) {
      return;
    }
    void requestSkillWorkshopRevision(
      scope.state,
      scope.context,
      proposalId,
      this.handleRevisionRequest,
      () => this.isCurrentSourceScope(scope),
    )
      .then((outcome) => {
        if (!outcome || outcome.status !== "admitted" || !this.isCurrentSourceScope(scope)) {
          return;
        }
        scope.navigate(
          "chat",
          sessionNavigationTarget({
            context: scope.context,
            face: "chat",
            sessionKey: outcome.sessionKey,
          }).options,
        );
      })
      .finally(this.requestPageUpdate);
  };

  override willUpdate() {
    if (!this.state && this.context) {
      this.state = createSkillWorkshopState(this.data);
      this.state.skillWorkshopMode = loadSkillWorkshopMode();
    }
  }

  override updated() {
    if (this.state && this.context) {
      this.revisionRecovery.sync(this.context, this.state);
    }
    // Only kick a load when none is in flight and the last attempt did not
    // fail: loadProposals early-returns resolve immediately and their finally
    // schedules another update, so re-kicking here would spin forever when a
    // load stays pending or the gateway keeps erroring.
    const state = this.state;
    const canLoad =
      state &&
      !state.skillWorkshopLoaded &&
      !state.skillWorkshopLoading &&
      !state.skillWorkshopError;
    if (this.gatewayConnected && canLoad) {
      this.loadProposals(false);
    }
    this.ensureWorkshopAgentIdentity();
    const runtimeConfig = this.context?.runtimeConfig;
    if (
      runtimeConfig &&
      this.gatewayConnected &&
      !runtimeConfig.state.configSnapshot &&
      !runtimeConfig.state.configLoading
    ) {
      void runtimeConfig.ensureLoaded();
    }
  }

  private resetSourceState() {
    this.operationEpoch += 1;
    this.selfLearningBusy = false;
    this.selfLearningError = null;
    this.learningBusy = false;
    this.learningError = null;
    const previous = this.state;
    if (!previous) {
      return;
    }
    if (previous.skillWorkshopActionNoticeTimer) {
      globalThis.clearTimeout(previous.skillWorkshopActionNoticeTimer);
    }
    const next = createSkillWorkshopState();
    next.skillWorkshopAgentId = previous.skillWorkshopAgentId;
    next.skillWorkshopQuery = previous.skillWorkshopQuery;
    next.skillWorkshopQueueWidth = previous.skillWorkshopQueueWidth;
    next.skillWorkshopMode = previous.skillWorkshopMode;
    this.state = next;
    this.requestPageUpdate();
  }

  private applyGatewaySnapshot(
    gateway: SkillWorkshopPageContext["gateway"],
    snapshot: ApplicationGatewaySnapshot,
    sourceEpochChanged: boolean,
  ) {
    this.gatewaySource = gateway;
    this.gatewayClient = snapshot.client;
    this.gatewayHello = snapshot.hello;
    this.gatewayConnected = snapshot.phase === "connected";
    if (sourceEpochChanged) {
      this.resetSourceState();
    }
    if (
      snapshot.phase === "connected" &&
      (sourceEpochChanged || !this.state?.skillWorkshopLoaded)
    ) {
      this.loadProposals(sourceEpochChanged);
    }
  }

  private captureSourceScope(): SkillWorkshopSourceScope | null {
    return captureSkillWorkshopSourceScope({
      state: this.state,
      context: this.context,
      epoch: this.operationEpoch,
    });
  }

  private isCurrentSourceScope(scope: SkillWorkshopSourceScope): boolean {
    return isCurrentSkillWorkshopSourceScope(scope, {
      state: this.state,
      context: this.context,
      epoch: this.operationEpoch,
    });
  }

  private loadProposals(force: boolean) {
    const state = this.state;
    const context = this.context;
    if (!state || !context || context.gateway.snapshot.phase !== "connected") {
      return;
    }
    // The loaders own in-flight state. Even a later no-op load must not suppress
    // the productive request's terminal repaint; resets already replace its state.
    void loadSkillWorkshopProposals(state, context, {
      force,
      onProgress: this.requestPageUpdate,
    }).finally(this.requestPageUpdate);
    this.requestPageUpdate();
  }

  private readonly handleLearn = async () => {
    const scope = this.captureSourceScope();
    const client = scope?.context.gateway.snapshot.client;
    if (!scope || !client || this.learningBusy) {
      return;
    }
    const { context } = scope;
    const hello = context.gateway.snapshot.hello;
    const agentId = resolveSkillWorkshopAgentId(context);
    const message = SKILL_WORKSHOP_LEARNING_PROMPT;
    const params = {
      agentId,
      displayName: t("skillWorkshop.learning.title"),
      message,
      idempotencyKey: generateUUID(),
    };
    const access = readSessionMethodAccess(context.gateway.snapshot, {
      method: "sessions.create",
      params,
    });
    if (!access.allowed) {
      this.learningError = access.reason;
      this.requestPageUpdate();
      return;
    }
    this.learningBusy = true;
    this.learningError = null;
    this.requestPageUpdate();
    const createdAt = Date.now();
    try {
      const result = await context.sessions.createResult(params, { reconciliation: "background" });
      if (context.gateway.snapshot.client !== client || context.gateway.snapshot.hello !== hello) {
        return;
      }
      if (!result) {
        if (this.isCurrentSourceScope(scope)) {
          this.learningError =
            context.sessions.state.error ?? t("skillWorkshop.learning.startFailed");
        }
        return;
      }
      // The accepted session outlives this page; only navigation belongs to the current view.
      if (result.initialRun.status === "started") {
        context.chatSubmissions.retain(
          buildInitialChatSubmission(
            result.key,
            { text: message, createdAt },
            client,
            result.initialRun.runId,
          ),
        );
      } else if (result.initialRun.status === "rejected") {
        retainRejectedInitialTurn({
          context,
          agentId,
          sessionKey: result.key,
          message,
          attachments: [],
          error: result.initialRun.error,
        });
      }
      if (!this.isCurrentSourceScope(scope)) {
        return;
      }
      context.navigate(
        "chat",
        sessionNavigationTarget({
          context,
          face: "chat",
          sessionKey: result.key,
          agentId,
          navigationKey: result.key,
        }).options,
      );
    } finally {
      if (this.isCurrentSourceScope(scope)) {
        this.learningBusy = false;
        this.requestPageUpdate();
      }
    }
  };

  private readonly handleSelfLearningToggle = (enabled: boolean) => {
    void this.applySelfLearningToggle(enabled);
  };

  private async applySelfLearningToggle(enabled: boolean): Promise<void> {
    if (!canCallWorkshopAdminMethod(this.context?.gateway?.snapshot, "config.patch")) {
      return;
    }
    const scope = this.captureSourceScope();
    const runtimeConfig = scope?.context.runtimeConfig;
    if (!scope || !runtimeConfig || this.selfLearningBusy) {
      return;
    }
    this.selfLearningBusy = true;
    this.selfLearningError = null;
    this.requestPageUpdate();
    try {
      const error = await setSelfLearningEnabled(runtimeConfig, enabled, () =>
        this.isCurrentSourceScope(scope),
      );
      if (this.isCurrentSourceScope(scope)) {
        this.selfLearningError = error;
      }
    } finally {
      if (this.isCurrentSourceScope(scope)) {
        this.selfLearningBusy = false;
        this.requestPageUpdate();
      }
    }
  }

  private ensureWorkshopAgentIdentity(): void {
    const context = this.context;
    const agentId = this.state?.skillWorkshopAgentId;
    if (!context || !agentId || context.agentIdentity.get(agentId)) {
      return;
    }
    void context.agentIdentity.ensure([agentId]);
  }

  override disconnectedCallback() {
    this.subscriptions.clear();
    this.resetSourceState();
    super.disconnectedCallback();
  }

  override render() {
    return this.state && this.context
      ? renderSkillWorkshopPage(
          this.state,
          {
            context: this.context,
            revisionRecoveryActive: this.revisionRecovery.active,
            workshopAgentName:
              this.context.agentIdentity.get(this.state.skillWorkshopAgentId)?.name?.trim() ?? "",
            onEvaluate: this.handleEvaluation,
            onRevisionSubmit: this.handleRevisionSubmit,
            selfLearning: resolveSelfLearning(
              this.context.runtimeConfig,
              this.selfLearningBusy,
              this.selfLearningError,
              canCallWorkshopAdminMethod(this.context.gateway.snapshot, "config.patch"),
            ),
            onSelfLearningToggle: this.handleSelfLearningToggle,
            learningBusy: this.learningBusy,
            learningError: this.learningError,
            onLearn: this.handleLearn,
            onRetry: () => this.loadProposals(true),
          },
          this.requestPageUpdate,
        )
      : nothing;
  }
}

if (!customElements.get("openclaw-skill-workshop-page")) {
  customElements.define("openclaw-skill-workshop-page", SkillWorkshopPage);
}
