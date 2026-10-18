import type { SkillsWorkshopReadResult } from "@openclaw/gateway-protocol";
import { createEffect, createMemo, createSignal, onCleanup } from "solid-js";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import type { ApplicationContext } from "../../app/context.ts";
import { formatUiError } from "../../lib/format-error.ts";
import { projectGateway, projectAgentSelection } from "../../lib/reactive/application.ts";
import { useApplication } from "../../lib/reactive/context.ts";
import { projectAgents, projectRuntimeConfig } from "../../lib/reactive/domain-capabilities.ts";
import { t } from "../../lib/reactive/i18n.ts";
import { readSessionMethodAccess } from "../../lib/session-method-access.ts";
import { sessionNavigationTarget } from "../../lib/sessions/route-navigation.ts";
import {
  normalizeAgentId,
  parseAgentSessionKey,
  resolveUiSelectedGlobalAgentId,
} from "../../lib/sessions/session-key.ts";
import { generateUUID } from "../../lib/uuid.ts";
import { defineSolidBridge } from "../../lit/solid-bridge.ts";
import { buildInitialChatSubmission } from "../chat/user-message-content.ts";
import { retainRejectedInitialTurn } from "../new-session/rejected-initial-turn.ts";
import { resolveWorkshopAccess } from "./access.ts";
import { loadWorkshopSnapshot, type WorkshopMutation, type WorkshopSnapshot } from "./api.ts";
import { SKILL_WORKSHOP_LEARNING_PROMPT } from "./learning-prompt.ts";
import { resolveWorkshopMode, setWorkshopMode, type SkillWorkshopMode } from "./mode.ts";
import {
  archivedWorkshopSkills,
  SkillWorkshopView,
  sortWorkshopSkills,
  type WorkshopFilter,
  type WorkshopSort,
  type WorkshopTab,
  type WorkshopViewer,
  type WorkshopViewerTarget,
} from "./view.tsx";

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

class SkillWorkshopPageState {
  private scope: WorkshopScope | null = null;
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
  private filter: WorkshopFilter = "active";
  private sort: WorkshopSort = "uses";
  private tab: WorkshopTab = "instructions";

  constructor(
    private readonly context: ApplicationContext,
    private readonly revision: () => number,
    private readonly changed: () => void,
  ) {
    const gateway = projectGateway(context.gateway);
    const selection = projectAgentSelection(context.agentSelection);
    const agents = projectAgents(context.agents);
    const config = projectRuntimeConfig(context.runtimeConfig);
    createEffect(
      () =>
        [gateway.revision(), selection.revision(), agents.revision(), config.revision()] as const,
      () => {
        this.syncScope();
        changed();
      },
    );
    onCleanup(() => {
      this.scope = null;
    });
  }

  private syncScope() {
    const context = this.context;
    const snapshot = context?.gateway.snapshot;
    const client = snapshot?.phase === "connected" ? snapshot.client : null;
    const agentId = context && client ? resolveWorkshopAgentId(context) : null;
    if (client === (this.scope?.client ?? null) && agentId === (this.scope?.agentId ?? null)) {
      return;
    }
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

  private async load(): Promise<void> {
    const scope = this.scope;
    if (!scope) {
      return;
    }
    void this.context?.runtimeConfig.ensureLoaded();
    this.loading = true;
    this.error = null;
    this.changed();
    try {
      const snapshot = await loadWorkshopSnapshot(scope.client, scope.agentId);
      if (this.scope !== scope) {
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
      // A chat notice links here with ?skill=<name>; open it in whichever list holds it.
      const requested = this.viewer
        ? null
        : new URLSearchParams(this.context?.router.getState().location.search).get("skill");
      const requestedLive = snapshot.list.skills.some((skill) => skill.name === requested);
      if (
        requested &&
        (requestedLive || snapshot.list.archived.some((skill) => skill.name === requested))
      ) {
        this.filter = requestedLive ? "active" : "archived";
        this.selectSkill(requested);
      } else if (!this.viewer) {
        this.selectFirst();
      }
    } catch (error) {
      this.error = formatUiError(error);
    } finally {
      this.loading = false;
      this.changed();
    }
  }

  private async open(target: WorkshopViewerTarget): Promise<void> {
    const scope = this.scope;
    if (!scope) {
      return;
    }
    const viewer: WorkshopViewer = { target, status: "loading" };
    this.viewer = viewer;
    this.changed();
    const read = (params: Partial<WorkshopViewerTarget>) =>
      scope.client.request<SkillsWorkshopReadResult>("skills.workshop.read", {
        agentId: scope.agentId,
        name: target.name,
        filePath: params.filePath,
        ...(params.versionId ? { versionId: params.versionId } : {}),
      });
    // A past SKILL.md of a live skill is compared against today's copy.
    const compare =
      target.versionId !== undefined &&
      target.filePath === "SKILL.md" &&
      this.snapshot?.list.skills.some((skill) => skill.name === target.name) === true;
    let next: WorkshopViewer;
    try {
      const [result, current] = await Promise.all([
        read(target),
        compare ? read({ filePath: "SKILL.md" }) : undefined,
      ]);
      next = { target, status: "ready", result, ...(current ? { current: current.content } : {}) };
    } catch (error) {
      next = { target, status: "error", error: formatUiError(error) };
    }
    if (this.scope === scope && this.viewer?.target === target) {
      this.viewer = next;
      this.changed();
    }
  }

  /** Selects the top row of the current list so the detail pane is never empty. */
  private selectFirst() {
    const snapshot = this.snapshot;
    if (!snapshot) {
      return;
    }
    const name =
      this.filter === "active"
        ? sortWorkshopSkills(snapshot.list.skills, snapshot.changes, this.sort)[0]?.name
        : archivedWorkshopSkills(snapshot.list)[0]?.name;
    if (name) {
      this.selectSkill(name);
    } else {
      this.viewer = null;
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
      if (this.tab === "files" || this.viewer?.target.name !== name) {
        this.tab = this.tab === "history" ? "history" : "instructions";
      }
      void this.open({ name, filePath: "SKILL.md", versionId });
    }
  };

  private readonly setFilter = (filter: WorkshopFilter) => {
    if (filter === this.filter) {
      return;
    }
    this.filter = filter;
    this.tab = "instructions";
    this.selectFirst();
    this.changed();
  };

  private readonly setTab = (tab: WorkshopTab) => {
    this.tab = tab;
    const target = this.viewer?.target;
    if (target) {
      const files = this.viewer?.status === "ready" ? this.viewer.result.files : [];
      const support = files.find((file) => file !== "SKILL.md");
      if (tab === "files" && target.filePath === "SKILL.md" && support) {
        void this.open({ name: target.name, filePath: support, versionId: target.versionId });
      } else if (tab === "instructions" && target.filePath !== "SKILL.md") {
        void this.open({ name: target.name, filePath: "SKILL.md", versionId: target.versionId });
      }
    }
    this.changed();
  };

  private readonly mutate = async (mutation: WorkshopMutation, key: string) => {
    const scope = this.scope;
    const access = resolveWorkshopAccess(this.context?.gateway.snapshot);
    const allowed =
      mutation.method === "skills.workshop.archive" ? access.canArchive : access.canRestore;
    if (!scope || !allowed || this.pendingAction) {
      return;
    }
    this.pendingAction = key;
    this.actionError = null;
    this.changed();
    try {
      const { method, ...params } = mutation;
      await scope.client.request(method, { agentId: scope.agentId, ...params });
      if (this.scope !== scope) {
        return;
      }
      await this.load();
      if (this.scope !== scope) {
        return;
      }
      // Archiving or restoring moves the skill between lists; follow it there.
      const live = this.snapshot?.list.skills.some((skill) => skill.name === mutation.name);
      if (this.viewer?.target.name === mutation.name || this.viewer === null) {
        this.filter = live ? "active" : "archived";
        this.selectSkill(mutation.name);
      }
    } catch (error) {
      if (this.scope === scope) {
        this.actionError = formatUiError(error);
      }
    } finally {
      if (this.scope === scope) {
        this.pendingAction = null;
        this.changed();
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
    this.modeBusy = true;
    this.modeError = null;
    this.changed();
    try {
      const error = await setWorkshopMode(runtimeConfig, mode);
      if (this.context === context) {
        this.modeError = error;
      }
    } finally {
      this.modeBusy = false;
      this.changed();
    }
  };

  private readonly learn = async () => {
    const context = this.context;
    const scope = this.scope;
    if (!context || !scope || this.learningBusy) {
      return;
    }
    const { client, agentId } = scope;
    const isCurrent = () => this.context === context && this.scope === scope;
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
      this.changed();
      return;
    }
    this.learningBusy = true;
    this.learningError = null;
    this.changed();
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
      if (!isCurrent()) {
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
        this.changed();
      }
    }
  };

  viewProps() {
    this.revision();
    const context = this.context;
    return {
      context,
      agentId: this.scope?.agentId ?? null,
      access: resolveWorkshopAccess(context.gateway.snapshot),
      snapshot: this.snapshot,
      loading: this.loading,
      error:
        this.error ??
        (context.runtimeConfig.state.configSnapshot ? null : context.runtimeConfig.state.lastError),
      viewer: this.viewer,
      filter: this.filter,
      sort: this.sort,
      tab: this.tab,
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
      onOpen: (target: WorkshopViewerTarget) => void this.open(target),
      onMutate: (mutation: WorkshopMutation, key: string) => void this.mutate(mutation, key),
      onModeChange: (mode: SkillWorkshopMode) => void this.setMode(mode),
      onLearn: () => void this.learn(),
      onFilter: this.setFilter,
      onSort: (sort: WorkshopSort) => {
        this.sort = sort;
        this.changed();
      },
      onTab: this.setTab,
    };
  }
}

export const SkillWorkshopPage = defineSolidBridge(
  "openclaw-skill-workshop-page",
  () => {
    const [revision, setRevision] = createSignal(0, { ownedWrite: true });
    const state = new SkillWorkshopPageState(useApplication(), revision, () => {
      setRevision((value) => value + 1);
    });
    const view = createMemo(() => state.viewProps());
    return <SkillWorkshopView view={view} />;
  },
  { properties: {} },
);
