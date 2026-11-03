import type { SkillsWorkshopReadResult } from "@openclaw/gateway-protocol";
import {
  action,
  affects,
  createMemo,
  createOptimistic,
  createSignal,
  onSettled,
  refresh,
} from "solid-js";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import type { ApplicationContext } from "../../app/context.ts";
import { formatUiError } from "../../lib/format-error.ts";
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
import { buildInitialChatSubmission } from "../chat/user-message-content.ts";
import { retainRejectedInitialTurn } from "../new-session/rejected-initial-turn.ts";
import { canRunWorkshopMutation, resolveWorkshopAccess } from "./access.ts";
import { loadWorkshopSnapshot, type WorkshopMutation, type WorkshopSnapshot } from "./api.ts";
import { SKILL_WORKSHOP_LEARNING_PROMPT } from "./learning-prompt.ts";
import { resolveWorkshopMode, setWorkshopMode, type SkillWorkshopMode } from "./mode.ts";
import type { WorkshopViewerResult } from "./view-shared.tsx";
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

type WorkshopScope = {
  client: GatewayBrowserClient;
  agentId: string;
  abort: AbortController;
  retired: Promise<void>;
  retire: () => void;
};

function resolveWorkshopAgentId(context: ApplicationContext): string {
  const snapshot = context.gateway.snapshot;
  return normalizeAgentId(
    context.agentSelection.state.selectedId ||
      parseAgentSessionKey(snapshot.sessionKey)?.agentId ||
      resolveUiSelectedGlobalAgentId(snapshot),
  );
}

class SkillWorkshopPageState {
  scope: WorkshopScope | null = null;
  listRequest: { result: Promise<WorkshopSnapshot | null> } | null = null;
  viewerRequest: { result: Promise<WorkshopViewerResult | null> } | null = null;
  private snapshot: WorkshopSnapshot | null = null;
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
    private readonly changed: () => void,
  ) {
    onSettled(() => {
      const sync = () => {
        this.syncScope();
        changed();
      };
      const stops = [
        // Connection receipts retire the prior workshop scope before pending operations settle.
        context.gateway.subscribe(sync),
        // Selection receipts abort prior-agent work before another workshop action starts.
        context.agentSelection.subscribe(sync),
      ];
      sync();
      return () => {
        stops.forEach((stop) => stop());
        this.scope?.abort.abort();
        this.scope?.retire();
        this.scope = null;
      };
    });
  }

  private syncScope() {
    const context = this.context;
    const snapshot = context.gateway.snapshot;
    const client = snapshot.phase === "connected" ? snapshot.client : null;
    const agentId = client ? resolveWorkshopAgentId(context) : null;
    if (client === (this.scope?.client ?? null) && agentId === (this.scope?.agentId ?? null)) {
      return;
    }
    this.scope?.abort.abort();
    this.scope?.retire();
    const retired = Promise.withResolvers<void>();
    this.scope =
      client && agentId
        ? {
            client,
            agentId,
            abort: new AbortController(),
            retired: retired.promise,
            retire: retired.resolve,
          }
        : null;
    this.snapshot = null;
    this.listRequest = null;
    this.viewerRequest = null;
    this.viewer = null;
    this.pendingAction = null;
    this.actionError = null;
    this.learningBusy = false;
    this.learningError = null;
    this.modeBusy = false;
    this.modeError = null;
    if (this.scope) {
      void this.load();
    }
  }

  private load(retry = false): Promise<void> {
    const scope = this.scope;
    if (!scope) {
      return Promise.resolve();
    }
    // Retry is the user's explicit reread; ensure waits out a recent failed read.
    void (retry ? this.context.runtimeConfig.refresh() : this.context.runtimeConfig.ensureLoaded());
    const result = loadWorkshopSnapshot(scope.client, scope.agentId).then((snapshot) => {
      if (this.scope !== scope) {
        return null;
      }
      this.snapshot = snapshot;
      const selected = this.viewer?.target;
      if (
        selected &&
        (selected.draftId
          ? !snapshot.list.drafts?.some((draft) => draft.id === selected.draftId)
          : !snapshot.list.skills.some((skill) => skill.name === selected.name) &&
            !snapshot.list.archived.some((skill) => skill.name === selected.name))
      ) {
        this.viewer = null;
      }
      // A chat notice links here with ?skill=<name>; open it in whichever list holds it.
      const requested = this.viewer
        ? null
        : new URLSearchParams(this.context.router.getState().location.search).get("skill");
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
      this.changed();
      return snapshot;
    });
    this.listRequest = { result };
    this.changed();
    // The rendering read presents rejection; callers only join owner settlement.
    return result.then(
      () => undefined,
      () => undefined,
    );
  }

  private async open(target: WorkshopViewerTarget): Promise<void> {
    const scope = this.scope;
    if (!scope) {
      return;
    }
    this.viewer = { target };
    const read = (params: Partial<WorkshopViewerTarget>) =>
      scope.client.request<SkillsWorkshopReadResult>("skills.workshop.read", {
        agentId: scope.agentId,
        name: target.name,
        filePath: params.filePath,
        ...(params.versionId ? { versionId: params.versionId } : {}),
        ...(params.draftId ? { draftId: params.draftId } : {}),
      });
    // A past or drafted SKILL.md of a live skill is compared against today's copy.
    const compare =
      (target.versionId !== undefined || target.draftId !== undefined) &&
      target.filePath === "SKILL.md" &&
      this.snapshot?.list.skills.some((skill) => skill.name === target.name) === true;
    const pending = Promise.all([
      read(target),
      compare ? read({ filePath: "SKILL.md" }) : undefined,
    ]).then(([result, current]) => {
      if (this.scope !== scope || this.viewer?.target !== target) {
        return null;
      }
      const next = { target, result, ...(current ? { current: current.content } : {}) };
      this.viewer = next;
      this.changed();
      return next;
    });
    this.viewerRequest = { result: pending };
    this.changed();
    await pending.catch(() => undefined);
  }

  /** Selects the top row of the current list so the detail pane is never empty. */
  private selectFirst() {
    const snapshot = this.snapshot;
    if (!snapshot) {
      return;
    }
    if (this.filter === "drafts") {
      // The list shows drafts newest first; select its top row.
      const draft = snapshot.list.drafts?.at(-1);
      if (draft) {
        this.selectDraft(draft.id);
      } else {
        this.viewer = null;
      }
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

  private readonly selectDraft = (draftId: string) => {
    const draft = this.snapshot?.list.drafts?.find((entry) => entry.id === draftId);
    if (draft) {
      void this.open({ name: draft.skillName, filePath: "SKILL.md", draftId });
    }
  };

  // A live skill opens at its current SKILL.md; an archived one at its newest saved version.
  private readonly selectSkill = (name: string) => {
    const list = this.snapshot?.list;
    const live = list?.skills.some((skill) => skill.name === name);
    const versionId = live
      ? undefined
      : list?.archived.find((skill) => skill.name === name)?.versions[0]?.id;
    if (live || versionId) {
      this.tab = this.tab === "history" ? "history" : "instructions";
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
      const files = this.viewer?.result?.files ?? [];
      const support = files.find((file) => file !== "SKILL.md");
      if (tab === "files" && target.filePath === "SKILL.md" && support) {
        void this.open({ name: target.name, filePath: support, versionId: target.versionId });
      } else if (tab === "instructions" && target.filePath !== "SKILL.md") {
        void this.open({ name: target.name, filePath: "SKILL.md", versionId: target.versionId });
      }
    }
    this.changed();
  };

  readonly mutate = async (mutation: WorkshopMutation, key: string) => {
    const scope = this.scope;
    const access = resolveWorkshopAccess(this.context.gateway.snapshot);
    if (!scope || !canRunWorkshopMutation(access, mutation.method) || this.pendingAction) {
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
      // The reload already selected the next draft in the discarded one's place.
      if (mutation.method === "skills.workshop.discardDraft") {
        return;
      }
      // Applying, archiving or restoring moves the skill between lists; follow it there.
      const live = this.snapshot?.list.skills.some((skill) => skill.name === mutation.name);
      if (
        mutation.method === "skills.workshop.applyDraft" ||
        this.viewer?.target.name === mutation.name ||
        this.viewer === null
      ) {
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

  readonly setMode = async (mode: SkillWorkshopMode) => {
    const context = this.context;
    const scope = this.scope;
    if (this.modeBusy || !resolveWorkshopAccess(context.gateway.snapshot).canSetMode) {
      return;
    }
    this.modeBusy = true;
    this.modeError = null;
    this.changed();
    try {
      const error = await setWorkshopMode(context.runtimeConfig, mode);
      if (this.scope === scope) {
        this.modeError = error;
      }
    } catch (error) {
      if (this.scope === scope) {
        this.modeError = formatUiError(error);
      }
    } finally {
      if (this.scope === scope) {
        this.modeBusy = false;
        this.changed();
      }
    }
  };

  presentationFailed(kind: "mutation" | "mode" | "learning", error: unknown) {
    const message = formatUiError(error);
    if (kind === "mutation") {
      this.actionError = message;
    } else if (kind === "mode") {
      this.modeError = message;
    } else {
      this.learningError = message;
    }
    this.changed();
  }

  readonly learn = async () => {
    const context = this.context;
    const scope = this.scope;
    if (!scope || this.learningBusy) {
      return;
    }
    const { client, agentId } = scope;
    const isCurrent = () => this.scope === scope;
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
      const result = await context.sessions.createResult(params, {
        reconciliation: "background",
        signal: scope.abort.signal,
      });
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
    } catch (error) {
      if (isCurrent()) {
        this.learningError = formatUiError(error);
      }
    } finally {
      if (isCurrent()) {
        this.learningBusy = false;
        this.changed();
      }
    }
  };

  viewProps() {
    const context = this.context;
    return {
      context,
      agentId: this.scope?.agentId ?? null,
      access: resolveWorkshopAccess(context.gateway.snapshot),
      snapshot: this.snapshot,
      error: context.runtimeConfig.state.configSnapshot
        ? null
        : context.runtimeConfig.state.lastError,
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
      onRetry: () => void this.load(true),
      onSelectSkill: this.selectSkill,
      onSelectDraft: this.selectDraft,
      onOpen: (target: WorkshopViewerTarget) => void this.open(target),
      onFilter: this.setFilter,
      onSort: (sort: WorkshopSort) => {
        this.sort = sort;
        this.changed();
      },
      onTab: this.setTab,
    };
  }
}

export function SkillWorkshopPage() {
  const context = useApplication();
  const agents = projectAgents(context.agents);
  const runtimeConfig = projectRuntimeConfig(context.runtimeConfig);
  const [revision, setRevision] = createSignal(0, { ownedWrite: true });
  const state = new SkillWorkshopPageState(context, () => {
    setRevision((value) => value + 1);
  });
  const ownerView = createMemo(() => {
    revision();
    agents.read();
    runtimeConfig.read();
    return state.viewProps();
  });
  const scope = createMemo(() => {
    revision();
    return state.scope;
  });
  const listRequest = createMemo(() => {
    revision();
    return state.listRequest;
  });
  const viewerRequest = createMemo(() => {
    revision();
    return state.viewerRequest;
  });
  const list = createMemo(() => listRequest()?.result ?? Promise.resolve(null));
  const viewer = createMemo(() => viewerRequest()?.result ?? Promise.resolve(null));
  const mode = createMemo(() => ownerView().mode);
  const presentation = createMemo(() => {
    const currentScope = scope();
    const [pendingAction, setPendingAction] = createOptimistic<string | null>(null);
    const [modeBusy, setModeBusy] = createOptimistic(false);
    const [learningBusy, setLearningBusy] = createOptimistic(false);
    const [expectedMode, setExpectedMode] = createOptimistic(() => mode());
    return {
      currentScope,
      pendingAction,
      setPendingAction,
      modeBusy,
      setModeBusy,
      learningBusy,
      setLearningBusy,
      expectedMode,
      setExpectedMode,
    };
  });
  const present = action(function* (
    captured: ReturnType<typeof presentation>,
    result: Promise<void>,
    kind: "mutation" | "mode" | "learning",
    expected?: string,
  ) {
    if (state.scope === captured.currentScope) {
      if (kind === "mutation") {
        captured.setPendingAction(expected ?? null);
        affects(list);
      } else if (kind === "mode") {
        captured.setModeBusy(true);
        captured.setExpectedMode(expected === "auto" || expected === "propose" ? expected : "off");
      } else {
        captured.setLearningBusy(true);
      }
    }
    yield Promise.race([result, captured.currentScope?.retired ?? Promise.resolve()]);
    if (state.scope === captured.currentScope) {
      if (kind === "mutation") {
        // The owner already reloaded; this only reconciles its read receipt.
        yield refresh(list).catch(() => undefined);
      } else if (kind === "mode") {
        yield refresh(mode);
      }
    }
  });
  const run = async (
    kind: "mutation" | "mode" | "learning",
    operation: () => Promise<void>,
    expected?: string,
  ) => {
    const captured = presentation();
    const result = operation();
    // Land synchronous owner admission before joining the presentation transition.
    await Promise.resolve();
    try {
      await present(captured, result, kind, expected);
    } catch (error) {
      if (state.scope === captured.currentScope) {
        state.presentationFailed(kind, error);
      }
    }
  };
  const view = createMemo(() => {
    return {
      ...ownerView(),
      get pendingAction() {
        return presentation().pendingAction() ?? ownerView().pendingAction;
      },
      get modeBusy() {
        return presentation().modeBusy() || ownerView().modeBusy;
      },
      get learningBusy() {
        return presentation().learningBusy() || ownerView().learningBusy;
      },
      get mode() {
        return presentation().expectedMode();
      },
      onMutate: (mutation: WorkshopMutation, key: string) =>
        void run("mutation", () => state.mutate(mutation, key), key),
      onModeChange: (next: SkillWorkshopMode) => void run("mode", () => state.setMode(next), next),
      onLearn: () => void run("learning", state.learn),
    };
  });
  return (
    <openclaw-skill-workshop-page>
      <SkillWorkshopView view={view} reads={{ listRequest, list, viewerRequest, viewer }} />
    </openclaw-skill-workshop-page>
  );
}
