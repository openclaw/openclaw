import { html, nothing, type ReactiveControllerHost, type TemplateResult } from "lit";
import type { GatewaySessionRow } from "../api/types.ts";
import type { ApplicationContext } from "../app/context.ts";
import { t } from "../i18n/index.ts";
import { parseAgentSessionKey } from "../lib/sessions/session-key.ts";
import { icons } from "./icons.ts";
import {
  SessionMenuCommunication,
  type SessionCommunicationMenuAction,
} from "./session-communication-options.ts";
import { SessionDetailsController } from "./session-details-controller.ts";

type SessionSettingsActionKind =
  | "set-icon"
  | "set-color"
  | "assign-owner"
  | SessionCommunicationMenuAction["kind"];

type SessionMenuSettingsOptions = {
  context: () => ApplicationContext | undefined;
  readState: () => {
    session: Pick<GatewaySessionRow, "communication" | "effectiveCommunication"> & {
      target?: { key: string; agentId?: string };
      sessionId: string | null;
    };
    selectionCount: number;
    actionDisabledReasons: Partial<Record<SessionSettingsActionKind, string>>;
  };
  disabled: (kind: SessionSettingsActionKind) => boolean;
  renderSubmenu: (
    view: "settings" | "icon" | "assign-owner",
    label: string,
    icon: TemplateResult,
    disabled?: boolean,
    title?: string,
    inline?: boolean,
  ) => TemplateResult;
  runAction: (action: SessionCommunicationMenuAction) => void;
};

/** Composes session settings around capability-owned metadata and sparse communication edits. */
export class SessionMenuSettings {
  private settingsActive = false;
  private readonly settingsDetails;
  private communicationState() {
    const state = this.options.readState();
    return { ...state, session: this.settingsDetails.row ?? state.session };
  }
  private readonly communicationMenu = new SessionMenuCommunication({
    readState: () => this.communicationState(),
    disabled: () => this.options.disabled("set-communication"),
    disabledReason: () => this.options.readState().actionDisabledReasons["set-communication"],
    runAction: (action) => this.options.runAction(action),
  });

  constructor(
    host: ReactiveControllerHost,
    private readonly options: SessionMenuSettingsOptions,
  ) {
    this.settingsDetails = new SessionDetailsController(host, {
      captureScope: () => {
        const context = this.options.context();
        const connection = context?.sessions.captureConnectionScope();
        return context && connection ? { context, sessions: context.sessions, connection } : null;
      },
      isCurrent: (scope) =>
        this.options.context() === scope.context &&
        this.options.context()?.sessions === scope.sessions &&
        scope.sessions.isConnectionScopeCurrent(scope.connection),
      row: () => {
        const { session, selectionCount } = this.options.readState();
        return this.settingsActive && selectionCount === 1 && session.target
          ? {
              key: session.target.key,
              sessionId: session.sessionId ?? undefined,
              rowMode: "compact" as const,
            }
          : undefined;
      },
      agentId: (row, scope) =>
        this.options.readState().session.target?.agentId ??
        parseAgentSessionKey(row.key)?.agentId ??
        scope.context.agentSelection.state.selectedId ??
        "main",
    });

    host.addController({
      hostUpdate: () => {
        if (this.settingsActive) {
          this.settingsDetails.synchronize();
        }
      },
    });
  }

  get communicationAvailable(): boolean {
    return Boolean(this.communicationState().session.effectiveCommunication);
  }

  open(): void {
    this.settingsActive = true;
    this.settingsDetails.synchronize();
  }

  readonly close = () => {
    this.settingsActive = false;
    this.settingsDetails.reset();
  };

  handleSelect(value: string): boolean {
    if (value === "reload-settings") {
      this.settingsDetails.reset();
      this.settingsDetails.synchronize();
      return true;
    }
    return this.communicationMenu.handleSelect(value);
  }

  renderAction() {
    return this.options.readState().selectionCount > 1
      ? nothing
      : this.options.renderSubmenu("settings", t("sessionsView.sessionSettings"), icons.settings);
  }

  render(inline: boolean): TemplateResult {
    const state = this.options.readState();
    return html`
      ${this.options.renderSubmenu(
        "icon",
        t("sessionsView.setIconColorMenu"),
        icons.palette,
        this.options.disabled("set-icon") && this.options.disabled("set-color"),
        state.actionDisabledReasons["set-icon"] ?? state.actionDisabledReasons["set-color"],
        inline,
      )}
      ${this.options.renderSubmenu(
        "assign-owner",
        t("sessionsView.assignTo"),
        icons.users,
        this.options.disabled("assign-owner"),
        state.actionDisabledReasons["assign-owner"],
        inline,
      )}
      ${this.communicationMenu.renderActions(inline)}
      ${
        this.settingsDetails.error
          ? html`<div slot=${inline ? nothing : "submenu"} class="session-menu__info" role="alert">
                ${this.settingsDetails.error}
              </div>
              <wa-dropdown-item
                slot=${inline ? nothing : "submenu"}
                class="session-menu__item"
                value="reload-settings"
                ><span class="session-menu__text">${t("common.retry")}</span></wa-dropdown-item
              >`
          : nothing
      }
    `;
  }
}
