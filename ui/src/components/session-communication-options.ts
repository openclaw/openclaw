import { html, nothing, type TemplateResult } from "lit";
import type { SessionsPatchMutation } from "../../../packages/gateway-protocol/src/schema/sessions-patch.js";
import {
  SESSION_COMMUNICATION_MODES,
  type SessionCommunicationMode,
  type SessionCommunicationPolicy,
  type EffectiveSessionCommunicationPolicy,
} from "../../../packages/gateway-protocol/src/session-communication.js";
import { t } from "../i18n/index.ts";
import { icons } from "./icons.ts";

export type SessionCommunicationDirection = keyof EffectiveSessionCommunicationPolicy;

function communicationModeLabel(mode: SessionCommunicationMode): string {
  return t(
    mode === "always"
      ? "sessionsView.communication.always"
      : mode === "ask"
        ? "sessionsView.communication.ask"
        : "sessionsView.communication.never",
  );
}

function communicationDirectionLabel(direction: SessionCommunicationDirection): string {
  return t(
    direction === "send" ? "sessionsView.communication.send" : "sessionsView.communication.receive",
  );
}

function communicationDirectionTitle(direction: SessionCommunicationDirection): string {
  return t(
    direction === "send"
      ? "sessionsView.communication.sendDescription"
      : "sessionsView.communication.receiveDescription",
  );
}

function renderCommunicationOptions(params: {
  direction: SessionCommunicationDirection;
  communication: SessionCommunicationPolicy | undefined;
  effectiveCommunication: EffectiveSessionCommunicationPolicy;
  inline: boolean;
  disabled: boolean;
  disabledReason?: string;
}) {
  const { direction, communication, effectiveCommunication, inline, disabled, disabledReason } =
    params;
  const selected = effectiveCommunication[direction];
  return html`
    ${SESSION_COMMUNICATION_MODES.map(
      (mode) => html`
        <wa-dropdown-item
          slot=${inline ? nothing : "submenu"}
          class="session-menu__item session-menu__communication-option"
          type="checkbox"
          ?checked=${selected === mode}
          ?disabled=${disabled}
          title=${disabledReason ?? nothing}
          value=${`communication:${direction}:${mode}`}
        >
          <span class="session-menu__text">${communicationModeLabel(mode)}</span>
          ${
            selected === mode && communication?.[direction] === undefined
              ? html`<span class="session-menu__communication-default"
                  >${t("sessionsView.communication.default")}</span
                >`
              : nothing
          }
          ${
            selected === mode
              ? html`<span slot="details" class="session-menu__check" aria-hidden="true"
                  >${icons.check}</span
                >`
              : nothing
          }
        </wa-dropdown-item>
      `,
    )}
    ${
      communication?.send !== undefined || communication?.receive !== undefined
        ? html`
            <div
              slot=${inline ? nothing : "submenu"}
              class="session-menu__separator"
              role="separator"
            ></div>
            <wa-dropdown-item
              slot=${inline ? nothing : "submenu"}
              class="session-menu__item"
              value="communication:reset"
              ?disabled=${disabled}
              title=${disabledReason ?? t("sessionsView.communication.resetDescription")}
              ><span class="session-menu__text">${t("common.reset")}</span></wa-dropdown-item
            >
          `
        : nothing
    }
  `;
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
  renderSubmenu: (
    view: "communication-send" | "communication-receive",
    label: string,
    icon: TemplateResult,
    disabled: boolean,
    title: string,
    details: TemplateResult,
  ) => TemplateResult;
  runAction: (action: SessionCommunicationMenuAction) => void;
};

/** Owns communication menu presentation and translates selections into sparse patches. */
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

  renderActions() {
    const state = this.host.readState();
    const { communication, effectiveCommunication } = state.session;
    if (state.selectionCount > 1 || !effectiveCommunication) {
      return nothing;
    }
    const disabled = this.host.disabled();
    const reason = this.host.disabledReason();
    return html`
      <div class="session-menu__separator" role="separator"></div>
      <div class="session-menu__info">${t("sessionsView.communication.title")}</div>
      ${(["send", "receive"] as const).map((direction) =>
        this.host.renderSubmenu(
          direction === "send" ? "communication-send" : "communication-receive",
          communicationDirectionLabel(direction),
          direction === "send" ? icons.arrowUpRight : icons.arrowDown,
          disabled,
          reason ?? communicationDirectionTitle(direction),
          html`${communicationModeLabel(effectiveCommunication[direction])}${
            communication?.[direction] === undefined
              ? html`<span class="session-menu__communication-default"
                  >${t("sessionsView.communication.default")}</span
                >`
              : nothing
          }`,
        ),
      )}
      <div class="session-menu__info">${t("sessionsView.communication.helper")}</div>
    `;
  }

  renderSubmenu(direction: SessionCommunicationDirection, inline: boolean) {
    const { session } = this.host.readState();
    return session.effectiveCommunication
      ? renderCommunicationOptions({
          direction,
          communication: session.communication,
          effectiveCommunication: session.effectiveCommunication,
          inline,
          disabled: this.host.disabled(),
          disabledReason: this.host.disabledReason(),
        })
      : html``;
  }
}
