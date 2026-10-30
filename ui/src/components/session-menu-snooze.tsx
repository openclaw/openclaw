import { createSignal, onSettled, Show } from "solid-js";
import { registerSessionOrganizationEnglish } from "../i18n/locales/en-session-organization.ts";
import { formatTimeMs } from "../lib/format.ts";
import { t } from "../lib/reactive/i18n.ts";
import {
  formatCustomSnooze,
  localSnoozeInputValue,
  parseCustomSnooze,
  readCustomSnooze,
} from "../lib/sessions/custom-snooze.ts";
import {
  formatSessionSnoozeWakeTime,
  resolveSessionSnoozePresets,
} from "../lib/sessions/session-snooze.ts";
import { nativeListener } from "../lib/solid-native-listener.ts";
import type { SessionMenuActions, SessionMenuActionsState } from "./session-menu-actions.ts";
import type { MenuEntry, MenuItem } from "./solid/menu.tsx";
import { Popover, type PopoverHandle } from "./solid/popover.tsx";

registerSessionOrganizationEnglish();

export function useSessionSnoozeEntries(
  actions: SessionMenuActions,
  readState: () => SessionMenuActionsState,
): () => MenuEntry[] {
  const [error, setError] = createSignal(false);
  let anchor!: HTMLSpanElement;
  let input!: HTMLInputElement;
  let cancelButton!: HTMLButtonElement;
  let submitButton!: HTMLButtonElement;
  let popover: PopoverHandle | undefined;
  const labels = {
    hour: "sessionsView.snoozeHour",
    "three-hours": "sessionsView.snoozeThreeHours",
    evening: "sessionsView.snoozeEvening",
    tomorrow: "sessionsView.snoozeTomorrow",
    "next-week": "sessionsView.snoozeNextWeek",
  } as const;
  const disabled = () => actions.actionDisabled("snooze", actions.actionExtraDisabled("snooze"));
  const open = () => {
    setError(false);
    input.value = localSnoozeInputValue(
      new Date(readCustomSnooze(actions.customSnoozeKey) ?? Date.now() + 3_600_000),
    );
    input.min = localSnoozeInputValue(new Date(Date.now() + 60_000));
    popover?.overlay.bindTrigger(anchor.closest<HTMLElement>('[role="menuitem"]') ?? anchor);
    popover?.show();
  };
  const keydown = (event: KeyboardEvent) => {
    if (!popover?.overlay.open) {
      return false;
    }
    // Let the browser visit native date/time segments; focus guards own only the dialog edges.
    if (event.key === "Tab") {
      event.stopPropagation();
      return true;
    }
    // The nested popover, not the parent menu, owns Escape and form key input.
    popover.overlay.keydown(event);
    return true;
  };
  const cancel = nativeListener("click", () => popover?.overlay.request(false, "return"));
  const stopClick = nativeListener("click", (event) => event.stopPropagation());
  const stopKeydown = nativeListener("keydown", (event) => event.stopPropagation());
  onSettled(() => {
    actions.openCustomSnooze = open;
    actions.customSnoozeKeydown = keydown;
    return () => {
      if (actions.openCustomSnooze === open) {
        actions.openCustomSnooze = undefined;
      }
      if (actions.customSnoozeKeydown === keydown) {
        actions.customSnoozeKeydown = undefined;
      }
    };
  });
  const customLabel = (
    <span
      class="session-menu__text"
      ref={(node) => {
        anchor = node;
      }}
    >
      {t("sessionsView.snoozeChooseTime")}
    </span>
  );
  const picker = (
    <Popover
      id="session-custom-snooze"
      label={t("sessionsView.snoozeChooseTime")}
      anchor={anchor}
      class="session-menu__snooze-picker"
      placement="bottom-start"
      ref={(handle) => {
        popover = handle;
      }}
      onOpenChange={(isOpen) => {
        if (isOpen) {
          input.focus();
        }
      }}
    >
      <form
        novalidate
        ref={[stopClick, stopKeydown]}
        onSubmit={(event) => {
          event.preventDefault();
          const snoozedUntil = parseCustomSnooze(input.value);
          if (snoozedUntil === null) {
            setError(true);
            input.focus();
            return;
          }
          if (disabled()) {
            return;
          }
          popover?.hide();
          actions.runAction({ kind: "snooze", snoozedUntil, rememberCustom: true });
        }}
      >
        <span
          tabindex={0}
          onFocus={() => (submitButton.disabled ? cancelButton : submitButton).focus()}
        />
        <label class="field">
          <span>{t("sessionsView.snoozeDateTime")}</span>
          <input
            ref={(node) => {
              input = node;
            }}
            type="datetime-local"
            required
            step="60"
            aria-invalid={error() ? "true" : "false"}
            aria-describedby="session-custom-snooze-help"
            onInput={() => setError(false)}
          />
        </label>
        <p id="session-custom-snooze-help" class="muted">
          {t("sessionsView.snoozeLocalTime", {
            zone: Intl.DateTimeFormat().resolvedOptions().timeZone,
          })}
        </p>
        <Show when={error()}>
          <p role="alert">{t("sessionsView.snoozeFutureRequired")}</p>
        </Show>
        <div class="session-menu__snooze-buttons">
          <button type="button" class="btn" ref={[(node) => (cancelButton = node), cancel]}>
            {t("common.cancel")}
          </button>
          <button
            type="submit"
            class="btn primary"
            ref={(node) => (submitButton = node)}
            disabled={disabled()}
          >
            {t("sessionsView.snooze")}
          </button>
        </div>
        <span tabindex={0} onFocus={() => input.focus()} />
      </form>
    </Popover>
  );
  const entry = (id: string, label: string): MenuItem => ({
    id,
    label,
    class: "session-menu__item",
    labelClass: "session-menu__text",
    disabled: disabled(),
    attributes: { title: readState().actionDisabledReasons.snooze },
  });
  return () => {
    const now = new Date();
    const presets = resolveSessionSnoozePresets(now);
    const custom = readCustomSnooze(actions.customSnoozeKey);
    return [
      ...presets.map((preset) =>
        entry(
          `snooze:${preset.snoozedUntil}`,
          `${t(labels[preset.id])} · ${
            preset.id === "next-week"
              ? formatSessionSnoozeWakeTime(preset.snoozedUntil, now)
              : formatTimeMs(preset.snoozedUntil)
          }`,
        ),
      ),
      ...(custom !== null
        ? [
            entry(
              "snooze-reuse",
              `${t("sessionsView.snoozeCustom")} · ${formatCustomSnooze(custom)}`,
            ),
          ]
        : []),
      { ...entry("snooze-custom", t("sessionsView.snoozeChooseTime")), content: customLabel },
      { kind: "content", id: "snooze-picker", content: picker },
    ];
  };
}
