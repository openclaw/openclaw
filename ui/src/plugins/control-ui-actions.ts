import type { BoardGetParams } from "@openclaw/gateway-protocol";
import type {
  ControlUiAction,
  ControlUiComposerTask,
  ControlUiDraftProposal,
  ControlUiSession,
} from "../../../src/plugin-sdk/control-ui.js";
import type { PluginSessionMenuAction } from "../components/session-menu-solid.tsx";
import { i18n } from "../i18n/lib/translate.ts";
import { formatUiError } from "../lib/format-error.ts";
import type { ComposerTasks } from "../pages/chat/components/chat-composer-task.ts";
import type { ControlUiPluginCapability } from "./control-ui-capability.ts";
import { scopeControlUiHost } from "./control-ui-scope.ts";

/** The invoking pane's draft owner; `getDraft` reads ahead of the rendered `draft`. */
export type ControlUiComposerDraft = {
  draft: string;
  getDraft?: () => string;
  onDraftChange: (next: string) => void;
  /** The pane's task owner; it refuses tasks where no card can show them (a replacement). */
  tasks: () => ComposerTasks;
};

export function pluginSessionMenuActions(
  runtime: ControlUiPluginCapability,
  session: ControlUiSession,
): PluginSessionMenuAction[] {
  return runtime
    .registrations("actions")
    .filter((entry) => entry.value.placement === "session")
    .flatMap((entry) => {
      try {
        const state = entry.value.resolve?.({
          sessionKey: session.key,
          agentId: session.agentId,
          session: structuredClone(session),
        });
        return state?.hidden
          ? []
          : [
              {
                id: entry.key,
                label: state?.label ?? entry.value.label,
                disabled: state?.disabled,
              },
            ];
      } catch (error) {
        runtime.reportError(entry.pluginId, error);
        return [];
      }
    });
}

export async function runControlUiPluginAction(
  params: BoardGetParams & {
    runtime: ControlUiPluginCapability;
    id: string;
    placement: ControlUiAction["placement"];
    session?: ControlUiSession;
    composer?: ControlUiComposerDraft;
    signal: AbortSignal;
    isCurrent?: () => boolean;
    /** Runs this action again, for a failed task's Try again. */
    retry?: () => void;
  },
): Promise<void> {
  // The lazy native-plugin loader installs action copy before exposing registrations.
  if (params.placement === "session" && !params.session) {
    throw new Error(i18n.t("pluginUi.actionSessionUnavailable"));
  }
  const entry = params.runtime
    .registrations("actions")
    .find(
      (candidate) => candidate.key === params.id && candidate.value.placement === params.placement,
    );
  if (!entry) {
    throw new Error(
      i18n.t(
        params.placement === "session"
          ? "pluginUi.actionInactiveSession"
          : "pluginUi.actionInactiveView",
      ),
    );
  }
  const signal = AbortSignal.any([params.signal, entry.signal]);
  const check = () => {
    signal.throwIfAborted();
    if (params.isCurrent?.() === false) {
      throw new Error("This plugin UI view has ended.");
    }
  };
  check();
  const context = {
    sessionKey: params.sessionKey,
    agentId: params.agentId ?? params.session?.agentId,
    session: params.session ? structuredClone(params.session) : undefined,
  };
  const state = entry.value.resolve?.(context);
  // A resolver can synchronously withdraw its registration or remove the view.
  check();
  if (state?.hidden || state?.disabled) {
    throw new Error(
      i18n.t(
        params.placement === "session"
          ? "pluginUi.actionUnavailableSession"
          : "pluginUi.actionUnavailableView",
      ),
    );
  }
  const composer = params.placement === "composer" ? params.composer : undefined;
  // Like replacement composer operations, a retired handle throws instead of touching
  // whichever draft its pane presents next.
  const checkComposer = () => {
    if (signal.aborted || params.isCurrent?.() === false) {
      throw new Error("This plugin UI view has ended.");
    }
  };
  // Tasks this invocation started. A cancelled or retired one makes its error expected; a live
  // one shows the error itself, so its card never stays working after the action has ended.
  const tasks: ControlUiComposerTask[] = [];
  try {
    await entry.value.run({
      ...context,
      host: scopeControlUiHost(entry.host, signal, params.isCurrent),
      signal,
      composer: composer && {
        get draft() {
          checkComposer();
          return composer.getDraft?.() ?? composer.draft;
        },
        setDraft: (text: string) => {
          checkComposer();
          composer.onDraftChange(text);
        },
        startTask: ({ title }: { title: string }) => {
          checkComposer();
          const task = composer
            .tasks()
            .start({ title, signal, actionKey: entry.key, retry: params.retry });
          tasks.push(task);
          return task;
        },
        propose: async (text: string, proposal: ControlUiDraftProposal) => {
          checkComposer();
          return composer.tasks().offer(text, proposal.title, signal);
        },
      },
    });
  } catch (error) {
    if (tasks.some((task) => task.signal.aborted)) {
      return;
    }
    const live = tasks.at(-1);
    if (live) {
      live.fail(formatUiError(error));
      return;
    }
    throw error;
  }
  check();
}
