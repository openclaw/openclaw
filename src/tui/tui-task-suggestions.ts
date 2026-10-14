import type { Component, OverlayHandle, SelectItem } from "@earendil-works/pi-tui";
import { asOptionalObjectRecord } from "@openclaw/normalization-core/record-coerce";
import type { TaskSuggestion } from "../../packages/gateway-protocol/src/index.js";
import { formatErrorMessage } from "../infra/errors.js";
import { createTuiRefreshCoalescer } from "./coalesced-refresh.js";
import {
  TuiChoicePrompt,
  createTuiChoiceSelector,
  type TuiChoiceSelector,
} from "./components/choice-prompt.js";
import { tuiTheme as theme } from "./theme/theme.js";
import type { TuiBackend } from "./tui-backend.js";
import { sanitizeRenderableText } from "./tui-formatters.js";
import { matchesOwnedTuiSession } from "./tui-session-events.js";

type TaskSuggestionControllerDeps = {
  client: Pick<
    TuiBackend,
    | "getTaskSuggestionActionCapabilities"
    | "listTaskSuggestions"
    | "acceptTaskSuggestion"
    | "dismissTaskSuggestion"
  >;
  chatLog: { addSystem: (line: string) => void };
  getAgentId: () => string;
  getSessionKey: () => string;
  openOverlay: (component: Component) => OverlayHandle;
  closeOverlay: (handle: OverlayHandle) => void;
  requestRender: () => void;
  onAccepted: (sessionKey: string) => Promise<void> | void;
  createSelector?: (items: SelectItem[]) => TuiChoiceSelector;
};

const TASK_BIDI_CONTROL_RE = /[\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/g;
type TaskAction = SelectItem & { value: "accept" | "dismiss" };

const TASK_ACTIONS = [
  {
    value: "accept",
    label: "Start in a new session",
    description: "Open a new session to address this task",
  },
  {
    value: "dismiss",
    label: "Dismiss",
    description: "Dismiss this suggestion without starting work",
  },
] as const satisfies readonly TaskAction[];

function clean(text: string): string {
  return sanitizeTaskText(text.replace(/\s+/g, " ").trim());
}

function sanitizeTaskText(text: string): string {
  return sanitizeRenderableText(text.replace(TASK_BIDI_CONTROL_RE, ""));
}

function parseTuiTaskSuggestion(value: unknown): TaskSuggestion | null {
  const record = asOptionalObjectRecord(value);
  if (!record) {
    return null;
  }
  const required = ["id", "title", "prompt", "tldr", "cwd", "sessionKey"] as const;
  if (required.some((field) => typeof record[field] !== "string" || !record[field].trim())) {
    return null;
  }
  if (typeof record.createdAt !== "number" || record.createdAt < 0) {
    return null;
  }
  return {
    id: (record.id as string).trim(),
    title: (record.title as string).trim(),
    prompt: (record.prompt as string).trim(),
    tldr: (record.tldr as string).trim(),
    cwd: (record.cwd as string).trim(),
    sessionKey: (record.sessionKey as string).trim(),
    ...(typeof record.agentId === "string" && record.agentId.trim()
      ? { agentId: record.agentId.trim() }
      : {}),
    createdAt: record.createdAt,
  };
}

export function createTuiTaskSuggestionController(deps: TaskSuggestionControllerDeps) {
  const createSelector = deps.createSelector ?? createTuiChoiceSelector;
  const suggestions = new Map<string, TaskSuggestion>();
  const hiddenIds = new Set<string>();
  const resolvingIds = new Set<string>();
  type Presentation = { id: string; overlay?: OverlayHandle; actionKey: string };
  let active: Presentation | null = null;
  let revision = 0;
  let disposed = false;

  const closeActive = () => {
    if (active?.overlay) {
      deps.closeOverlay(active.overlay);
    }
    active = null;
  };

  const remove = (id: string) => {
    revision += 1;
    suggestions.delete(id);
    hiddenIds.delete(id);
    if (active?.id === id) {
      closeActive();
    }
  };

  const matchesSession = (suggestion: TaskSuggestion) =>
    matchesOwnedTuiSession(deps.getSessionKey(), deps.getAgentId(), suggestion);

  const availableActions = () => {
    const capabilities = deps.client.getTaskSuggestionActionCapabilities?.() ?? {
      canAccept: Boolean(deps.client.acceptTaskSuggestion),
      canDismiss: Boolean(deps.client.dismissTaskSuggestion),
    };
    return TASK_ACTIONS.filter((action) =>
      action.value === "accept" ? capabilities.canAccept : capabilities.canDismiss,
    );
  };

  const presentNext = () => {
    if (disposed) {
      return;
    }
    const actions = availableActions();
    const actionKey = actions.map((action) => action.value).join(",");
    if (active) {
      if (active.actionKey === actionKey) {
        return;
      }
      closeActive();
    }
    const suggestion = [...suggestions.values()]
      .toSorted((left, right) => left.createdAt - right.createdAt)
      .find(
        (entry) => !hiddenIds.has(entry.id) && !resolvingIds.has(entry.id) && matchesSession(entry),
      );
    if (!suggestion || actions.length === 0) {
      return;
    }

    const selector = createSelector(actions);
    const presentation: Presentation = { id: suggestion.id, actionKey };
    active = presentation;
    const dismissIndex = actions.findIndex((action) => action.value === "dismiss");
    selector.setSelectedIndex?.(Math.max(dismissIndex, 0));
    let acceptArmed = false;
    const prompt = new TuiChoicePrompt(
      theme.header(`Suggested follow-up: ${clean(suggestion.title)}`),
      [
        theme.dim(`Project: ${clean(suggestion.cwd)}`),
        theme.system(`Why: ${clean(suggestion.tldr)}`),
        theme.system("Instructions:"),
        theme.system(sanitizeTaskText(suggestion.prompt.trim())),
      ],
      selector,
      { lines: 12, titleLines: 2, requestRender: deps.requestRender },
    );

    const resolve = async (action: TaskAction) => {
      if (active !== presentation) {
        return;
      }
      closeActive();
      // Navigation clears manual dismissals, not ownership of an unfinished action.
      resolvingIds.add(suggestion.id);
      deps.requestRender();
      try {
        let acceptedKey: string | undefined;
        if (action.value === "accept") {
          if (!deps.client.acceptTaskSuggestion) {
            throw new Error("task suggestion acceptance is unavailable");
          }
          const result = await deps.client.acceptTaskSuggestion(suggestion.id);
          acceptedKey = result.key;
        } else {
          if (!deps.client.dismissTaskSuggestion) {
            throw new Error("task suggestion dismissal is unavailable");
          }
          const result = await deps.client.dismissTaskSuggestion(suggestion.id);
          if (!result.dismissed) {
            throw new Error("task suggestion is no longer pending");
          }
        }
        if (disposed) {
          return;
        }
        remove(suggestion.id);
        deps.chatLog.addSystem(
          acceptedKey ? `follow-up task started in ${acceptedKey}` : "follow-up task dismissed",
        );
        if (acceptedKey && matchesSession(suggestion)) {
          await deps.onAccepted(acceptedKey);
        }
      } catch (error) {
        if (disposed) {
          return;
        }
        deps.chatLog.addSystem(`follow-up task failed: ${formatErrorMessage(error)}`);
        void refresh().catch((refreshError: unknown) => {
          if (!disposed) {
            deps.chatLog.addSystem(
              `task suggestion refresh failed: ${formatErrorMessage(refreshError)}`,
            );
          }
        });
      } finally {
        resolvingIds.delete(suggestion.id);
      }
      presentNext();
      if (!disposed) {
        deps.requestRender();
      }
    };

    selector.onSelectionChange = () => {
      acceptArmed = false;
      prompt.setConfirmation("");
    };
    selector.onSelect = (item) => {
      if (active !== presentation) {
        return;
      }
      const selectedAction = actions.find((action) => action.value === item.value);
      if (!selectedAction || !availableActions().some((action) => action.value === item.value)) {
        closeActive();
        presentNext();
        deps.requestRender();
        return;
      }
      if (selectedAction.value === "dismiss" || acceptArmed) {
        void resolve(selectedAction);
        return;
      }
      acceptArmed = true;
      prompt.setConfirmation("Press Enter again to start this task.");
      deps.requestRender();
    };
    selector.onCancel = () => {
      if (active !== presentation) {
        return;
      }
      hiddenIds.add(suggestion.id);
      closeActive();
      deps.chatLog.addSystem("follow-up task hidden; suggestion remains pending");
      presentNext();
      deps.requestRender();
    };
    presentation.overlay = deps.openOverlay(prompt);
    deps.requestRender();
  };

  const refreshRunner = createTuiRefreshCoalescer(
    async (requestRerun) => {
      const startRevision = revision;
      const listed = await deps.client.listTaskSuggestions?.();
      if (disposed || !listed) {
        return false;
      }
      // An event raced this snapshot. Retry instead of resurrecting resolved work.
      if (revision !== startRevision) {
        requestRerun();
        return true;
      }
      suggestions.clear();
      for (const value of listed) {
        const suggestion = parseTuiTaskSuggestion(value);
        if (suggestion) {
          suggestions.set(suggestion.id, suggestion);
        }
      }
      for (const id of hiddenIds) {
        if (!suggestions.has(id)) {
          hiddenIds.delete(id);
        }
      }
      return true;
    },
    () => {
      if (active && !suggestions.has(active.id)) {
        closeActive();
      }
      presentNext();
      deps.requestRender();
    },
  );

  const refresh = async (): Promise<void> => {
    if (disposed || !deps.client.listTaskSuggestions) {
      return;
    }
    await refreshRunner.run();
  };

  return {
    handleEvent(event: string, payload: unknown) {
      const record = asOptionalObjectRecord(payload);
      if (disposed || event !== "task.suggestion" || !record) {
        return;
      }
      if (record.action === "created") {
        const suggestion = parseTuiTaskSuggestion(record.suggestion);
        if (suggestion) {
          revision += 1;
          hiddenIds.delete(suggestion.id);
          suggestions.set(suggestion.id, suggestion);
          presentNext();
        }
        return;
      }
      if (record.action === "resolved" && typeof record.taskId === "string") {
        remove(record.taskId);
        presentNext();
        deps.requestRender();
      }
    },
    refresh,
    sessionChanged() {
      if (disposed) {
        return;
      }
      hiddenIds.clear();
      const suggestion = active ? suggestions.get(active.id) : undefined;
      if (suggestion && !matchesSession(suggestion)) {
        closeActive();
      }
      presentNext();
      deps.requestRender();
    },
    dispose() {
      if (disposed) {
        return;
      }
      disposed = true;
      suggestions.clear();
      hiddenIds.clear();
      closeActive();
      deps.requestRender();
    },
  };
}
