import { html, nothing } from "lit";
import type { SessionsPatchMutation } from "../../../packages/gateway-protocol/src/schema/sessions-patch.js";
import {
  SESSION_COMMUNICATION_MODES,
  type SessionCommunicationMode,
  type SessionCommunicationPolicy,
  type EffectiveSessionCommunicationPolicy,
} from "../../../packages/gateway-protocol/src/session-communication.js";
import { t } from "../i18n/index.ts";

function communicationModeLabel(mode: SessionCommunicationMode): string {
  return t(
    mode === "always"
      ? "sessionsView.communication.always"
      : mode === "ask"
        ? "sessionsView.communication.ask"
        : "sessionsView.communication.never",
  );
}

export type SessionCommunicationMenuAction = {
  kind: "set-communication";
  communication: NonNullable<SessionsPatchMutation["communication"]> | null;
};

type SessionCommunicationMenuHost = {
  readState: () => {
    session: {
      communication?: SessionCommunicationPolicy;
      effectiveCommunication?: EffectiveSessionCommunicationPolicy;
    };
    selectionCount: number;
  };
  disabled: () => boolean;
  disabledReason: () => string | undefined;
  runAction: (action: SessionCommunicationMenuAction) => void;
};

/** Presents Gateway policy and translates choices into independent sparse patches. */
export class SessionMenuCommunication {
  constructor(private readonly host: SessionCommunicationMenuHost) {}

  handleSelect(value: string): boolean {
    if (value === "communication:reset") {
      this.host.runAction({ kind: "set-communication", communication: null });
      return true;
    }
    if (value.startsWith("communication:")) {
      const [, direction, selected] = value.split(":");
      const mode = SESSION_COMMUNICATION_MODES.find((candidate) => candidate === selected);
      if ((direction === "send" || direction === "receive") && mode) {
        this.host.runAction({ kind: "set-communication", communication: { [direction]: mode } });
      }
      return true;
    }
    return false;
  }

  renderActions(inline: boolean) {
    const state = this.host.readState();
    if (state.selectionCount > 1) {
      return nothing;
    }
    const { communication, effectiveCommunication } = state.session;
    const disabled = this.host.disabled() || !effectiveCommunication;
    const reason = this.host.disabledReason();
    return html`
      <div
        slot=${inline ? nothing : "submenu"}
        class="session-menu__separator"
        role="separator"
      ></div>
      <div slot=${inline ? nothing : "submenu"} class="session-menu__communication">
        ${(["send", "receive"] as const).map((direction) => {
          const label = t(
            direction === "send"
              ? "sessionsView.communication.send"
              : "sessionsView.communication.receive",
          );
          return html`<div class="session-menu__communication-row" title=${reason ?? nothing}>
            <span class="session-menu__text">${label}</span>
            <div class="session-menu__communication-picker" role="group" aria-label=${label}>
              ${SESSION_COMMUNICATION_MODES.map(
                (mode) => html`<button
                  type="button"
                  class="session-menu__communication-choice"
                  value=${`communication:${direction}:${mode}`}
                  aria-pressed=${effectiveCommunication?.[direction] === mode}
                  ?disabled=${disabled}
                  title=${reason ?? (communication?.[direction] === undefined && effectiveCommunication?.[direction] === mode ? t("sessionsView.communication.default") : nothing)}
                  @click=${(event: MouseEvent) => {
                    event.stopPropagation();
                    this.handleSelect(`communication:${direction}:${mode}`);
                  }}
                  @keydown=${(event: KeyboardEvent) => {
                    // Embedded controls own activation; Escape and Tab retain menu behavior.
                    if (event.key !== "Escape" && event.key !== "Tab") {
                      event.stopPropagation();
                    }
                  }}
                >
                  ${communicationModeLabel(mode)}
                </button>`,
              )}
            </div>
          </div>`;
        })}
      </div>
      ${
        communication?.send !== undefined || communication?.receive !== undefined
          ? html` <wa-dropdown-item
              slot=${inline ? nothing : "submenu"}
              class="session-menu__item"
              value="communication:reset"
              ?disabled=${disabled}
              title=${reason ?? t("sessionsView.communication.resetDescription")}
            >
              <span class="session-menu__text">${t("common.reset")}</span>
            </wa-dropdown-item>`
          : nothing
      }
    `;
  }
}
