import { html, nothing, type TemplateResult } from "lit";
import { t } from "../i18n/index.ts";
import {
  formatSessionSnoozeWakeTime,
  isSessionSnoozed,
  resolveSessionSnoozePresets,
} from "../lib/sessions/session-snooze.ts";
import { icons } from "./icons.ts";

export type SessionSnoozeMenuAction = { kind: "snooze"; snoozedUntil: number } | { kind: "wake" };
type SnoozeActionKind = SessionSnoozeMenuAction["kind"];
type SessionSnoozeMenuHost = {
  readWakeTime: () => number | null;
  eligible: () => boolean;
  disabled: (kind: SnoozeActionKind) => boolean;
  disabledReason: (kind: SnoozeActionKind) => string | undefined;
  renderItem: (kind: "wake", label: string, icon: TemplateResult) => TemplateResult;
  renderSubmenu: (
    view: "snooze",
    label: string,
    icon: TemplateResult,
    disabled: boolean,
    title?: string,
  ) => TemplateResult;
  runAction: (action: SessionSnoozeMenuAction) => void;
};

/** Owns snooze and wake menu presentation, preset labels, and selection dispatch. */
export class SessionMenuSnooze {
  constructor(private readonly host: SessionSnoozeMenuHost) {}

  handleSelect(value: string): boolean {
    if (value === "wake") {
      this.host.runAction({ kind: "wake" });
      return true;
    }
    if (!value.startsWith("snooze:")) {
      return false;
    }
    const snoozedUntil = Number(value.slice("snooze:".length));
    if (Number.isFinite(snoozedUntil) && snoozedUntil > Date.now()) {
      this.host.runAction({ kind: "snooze", snoozedUntil });
    }
    return true;
  }

  renderAction() {
    if (!this.host.eligible()) {
      return nothing;
    }
    const snoozedUntil = this.host.readWakeTime();
    return isSessionSnoozed({ snoozedUntil: snoozedUntil ?? undefined }, Date.now())
      ? this.host.renderItem(
          "wake",
          `${t("sessionsView.wakeSession")} · ${formatSessionSnoozeWakeTime(snoozedUntil!)}`,
          icons.clock,
        )
      : this.host.renderSubmenu(
          "snooze",
          t("sessionsView.snooze"),
          icons.clock,
          this.host.disabled("snooze"),
          this.host.disabledReason("snooze"),
        );
  }

  renderSubmenu(inline = false) {
    const now = new Date();
    const labels = {
      hour: "sessionsView.snoozeHour",
      "three-hours": "sessionsView.snoozeThreeHours",
      evening: "sessionsView.snoozeEvening",
      tomorrow: "sessionsView.snoozeTomorrow",
      "next-week": "sessionsView.snoozeNextWeek",
    } as const;
    return html`${resolveSessionSnoozePresets(now).map(
      ({ id, snoozedUntil }) => html`
        <wa-dropdown-item
          slot=${inline ? nothing : "submenu"}
          class="session-menu__item"
          value=${`snooze:${snoozedUntil}`}
          ?disabled=${this.host.disabled("snooze")}
          title=${this.host.disabledReason("snooze") ?? nothing}
          ><span class="session-menu__text"
            >${t(labels[id])} · ${formatSessionSnoozeWakeTime(snoozedUntil, now)}</span
          ></wa-dropdown-item
        >
      `,
    )}`;
  }
}
