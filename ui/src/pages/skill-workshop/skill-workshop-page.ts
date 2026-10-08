import { consume } from "@lit/context";
import type { SkillsWorkshopReadResult } from "@openclaw/gateway-protocol";
import { nothing } from "lit";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import { applicationContext, type ApplicationContext } from "../../app/context.ts";
import { t } from "../../i18n/index.ts";
import { registerSkillWorkshopEnglish } from "../../i18n/locales/en-skill-workshop.ts";
import { formatUiError } from "../../lib/format-error.ts";
import { readSessionMethodAccess } from "../../lib/session-method-access.ts";
import { sessionNavigationTarget } from "../../lib/sessions/route-navigation.ts";
import {
  normalizeAgentId,
  parseAgentSessionKey,
  resolveUiSelectedGlobalAgentId,
} from "../../lib/sessions/session-key.ts";
import { generateUUID } from "../../lib/uuid.ts";
import { OpenClawLightDomElement } from "../../lit/openclaw-element.ts";
import { SubscriptionsController } from "../../lit/subscriptions-controller.ts";
import { buildInitialChatSubmission } from "../chat/user-message-content.ts";
import { retainRejectedInitialTurn } from "../new-session/rejected-initial-turn.ts";
import { resolveWorkshopAccess } from "./access.ts";
import { loadWorkshopSnapshot, type WorkshopMutation, type WorkshopSnapshot } from "./api.ts";
import { SKILL_WORKSHOP_LEARNING_PROMPT } from "./learning-prompt.ts";
import { resolveWorkshopMode, setWorkshopMode, type SkillWorkshopMode } from "./mode.ts";
import { renderSkillWorkshop, type WorkshopViewer, type WorkshopViewerTarget } from "./view.ts";

registerSkillWorkshopEnglish();

type WorkshopScope = { client: GatewayBrowserClient; agentId: string };

function resolveWorkshopAgentId(context: ApplicationContext): string {
  const snapshot = context.gateway.snapshot;
  const selectedAgentId = context.agentSelection.state.selectedId;
  const sessionAgentId = parseAgentSessionKey(snapshot.sessionKey)?.agentId;
  return selectedAgentId
    ? normalizeAgentId(selectedAgentId)
    : sessionAgentId
      ? normalizeAgentId(sessionAgentId)
      : resolveUiSelectedGlobalAgentId(snapshot);
}

class SkillWorkshopPage extends OpenClawLightDomElement {
  @consume({ context: applicationContext, subscribe: true })
  private context?: ApplicationContext;

  // Every result is owned by one connection and agent; a scope change retires them all.
  private scope: WorkshopScope | null = null;
  private generation = 0;
  private loadSequence = 0;
  private snapshot: WorkshopSnapshot | null = null;
  private loading = false;
  private error: string | null = null;
  private viewer: WorkshopViewer | null = null;
  private pendingAction: string | null = null;
  private actionError: string | null = null;
  private modeBusy = false;
  private modeError: string | null = null;
  private learningBusy = false;
  private learningError: string | null = null;

  private readonly subscriptions = new SubscriptionsController(this)
    .watchStore(() => this.context?.gateway)
    .watchStore(() => this.context?.agentSelection)
    .watchStore(() => this.context?.agents)
    .watchStore(() => this.context?.runtimeConfig);

  override willUpdate() {
    const context = this.context;
    const snapshot = context?.gateway.snapshot;
    const client = snapshot?.phase === "connected" ? snapshot.client : null;
    const agentId = context && client ? resolveWorkshopAgentId(context) : null;
    if (client === (this.scope?.client ?? null) && agentId === (this.scope?.agentId ?? null)) {
      return;
    }
    this.generation += 1;
    this.scope = client && agentId ? { client, agentId } : null;
    this.snapshot = null;
    this.error = null;
    this.viewer = null;
    this.pendingAction = null;
    this.actionError = null;
    this.learningBusy = false;
    this.learningError = null;
    this.modeBusy = false;
    this.modeError = null;
    this.loading = false;
    if (this.scope) {
      void this.load();
    }
  }

  override updated() {
    const runtimeConfig = this.context?.runtimeConfig;
    if (
      this.scope &&
      runtimeConfig &&
      !runtimeConfig.state.configSnapshot &&
      !runtimeConfig.state.configLoading
    ) {
      void runtimeConfig.ensureLoaded();
    }
  }

  private async load(): Promise<void> {
    const scope = this.scope;
    if (!scope) {
      return;
    }
    const generation = this.generation;
    const sequence = ++this.loadSequence;
    const isCurrent = () => generation === this.generation && sequence === this.loadSequence;
    this.loading = true;
    this.error = null;
    this.requestUpdate();
    try {
      const snapshot = await loadWorkshopSnapshot(scope.client, scope.agentId);
      if (!isCurrent()) {
        return;
      }
      this.snapshot = snapshot;
      const selected = this.viewer?.target.name;
      if (
        selected &&
        !snapshot.list.skills.some((skill) => skill.name === selected) &&
        !snapshot.list.archived.some((skill) => skill.name === selected)
      ) {
        this.viewer = null;
      }
    } catch (error) {
      if (isCurrent()) {
        this.error = formatUiError(error);
      }
    } finally {
      if (isCurrent()) {
        this.loading = false;
        this.requestUpdate();
      }
    }
  }

  private async open(target: WorkshopViewerTarget): Promise<void> {
    const scope = this.scope;
    if (!scope) {
      return;
    }
    const generation = this.generation;
    const viewer: WorkshopViewer = { target, status: "loading" };
    this.viewer = viewer;
    this.requestUpdate();
    let next: WorkshopViewer;
    try {
      const result = await scope.client.request<SkillsWorkshopReadResult>("skills.workshop.read", {
        agentId: scope.agentId,
        name: target.name,
        filePath: target.filePath,
        ...(target.versionId ? { versionId: target.versionId } : {}),
      });
      next = { target, status: "ready", result };
    } catch (error) {
      next = { target, status: "error", error: formatUiError(error) };
    }
    if (generation === this.generation && this.viewer === viewer) {
      this.viewer = next;
      this.requestUpdate();
    }
  }

  // A live skill opens at its current SKILL.md; an archived one at its newest saved version.
  private readonly selectSkill = (name: string) => {
    const list = this.snapshot?.list;
    const live = list?.skills.some((skill) => skill.name === name);
    const versionId = live
      ? undefined
      : list?.archived.find((skill) => skill.name === name)?.versions[0]?.id;
    if (live || versionId) {
      void this.open({ name, filePath: "SKILL.md", versionId });
    }
  };

  private readonly mutate = async (mutation: WorkshopMutation, key: string) => {
    const scope = this.scope;
    const access = resolveWorkshopAccess(this.context?.gateway.snapshot);
    const allowed =
      mutation.method === "skills.workshop.archive" ? access.canArchive : access.canRestore;
    if (!scope || !allowed || this.pendingAction) {
      return;
    }
    const generation = this.generation;
    this.pendingAction = key;
    this.actionError = null;
    this.requestUpdate();
    try {
      const { method, ...params } = mutation;
      await scope.client.request(method, { agentId: scope.agentId, ...params });
      if (generation !== this.generation) {
        return;
      }
      await this.load();
      if (generation === this.generation && this.viewer?.target.name === mutation.name) {
        this.selectSkill(mutation.name);
      }
    } catch (error) {
      if (generation === this.generation) {
        this.actionError = formatUiError(error);
      }
    } finally {
      if (generation === this.generation) {
        this.pendingAction = null;
        this.requestUpdate();
      }
    }
  };

  private readonly setMode = async (mode: SkillWorkshopMode) => {
    const context = this.context;
    const runtimeConfig = context?.runtimeConfig;
    if (
      !context ||
      !runtimeConfig ||
      this.modeBusy ||
      !resolveWorkshopAccess(context.gateway.snapshot).canSetMode
    ) {
      return;
    }
    // A replaced application context or Gateway connection retires the write and its retry.
    const generation = this.generation;
    const isCurrent = () => this.context === context && generation === this.generation;
    this.modeBusy = true;
    this.modeError = null;
    this.requestUpdate();
    try {
      const error = await setWorkshopMode(runtimeConfig, mode, isCurrent);
      if (isCurrent()) {
        this.modeError = error;
      }
    } finally {
      if (isCurrent()) {
        this.modeBusy = false;
        this.requestUpdate();
      }
    }
  };

  private readonly learn = async () => {
    const context = this.context;
    const scope = this.scope;
    if (!context || !scope || this.learningBusy) {
      return;
    }
    const { client, agentId } = scope;
    const generation = this.generation;
    const isCurrent = () => this.context === context && generation === this.generation;
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
      this.requestUpdate();
      return;
    }
    this.learningBusy = true;
    this.learningError = null;
    this.requestUpdate();
    const createdAt = Date.now();
    try {
      const result = await context.sessions.createResult(params, { reconciliation: "background" });
      if (context.gateway.snapshot.client !== client) {
        return;
      }
      if (!result) {
        if (isCurrent()) {
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
      if (!isCurrent() || !this.isConnected) {
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
      if (isCurrent()) {
        this.learningBusy = false;
        this.requestUpdate();
      }
    }
  };

  override disconnectedCallback() {
    this.subscriptions.clear();
    this.generation += 1;
    this.scope = null;
    super.disconnectedCallback();
  }

  override render() {
    const context = this.context;
    if (!context) {
      return nothing;
    }
    return renderSkillWorkshop({
      context,
      agentId: this.scope?.agentId ?? null,
      access: resolveWorkshopAccess(context.gateway.snapshot),
      snapshot: this.snapshot,
      loading: this.loading,
      error: this.error,
      viewer: this.viewer,
      pendingAction: this.pendingAction,
      actionError: this.actionError,
      mode: resolveWorkshopMode(context.runtimeConfig),
      modeBusy: this.modeBusy,
      modeError: this.modeError,
      learningAccess: readSessionMethodAccess(context.gateway.snapshot, {
        method: "sessions.create",
      }),
      learningBusy: this.learningBusy,
      learningError: this.learningError,
      onRetry: () => void this.load(),
      onSelectSkill: this.selectSkill,
      onOpen: (target) => void this.open(target),
      onMutate: (mutation, key) => void this.mutate(mutation, key),
      onModeChange: (mode) => void this.setMode(mode),
      onLearn: () => void this.learn(),
    });
  }
}

if (!customElements.get("openclaw-skill-workshop-page")) {
  customElements.define("openclaw-skill-workshop-page", SkillWorkshopPage);
}
