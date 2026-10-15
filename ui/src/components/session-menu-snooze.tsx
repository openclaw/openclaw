import { createMemo, createSignal, For, onCleanup, Show, untrack } from "solid-js";
import { t } from "../i18n/index.ts";
import { formatTimeMs } from "../lib/format.ts";
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
import { SessionMenuItem } from "./session-menu-item.tsx";
import { Popover, type PopoverHandle } from "./solid/popover.tsx";

export function SessionSnoozeOptions(props: {
  actions: SessionMenuActions;
  state: SessionMenuActionsState;
  inline: boolean;
}) {
  // The menu controller is fixed for this mounted view; its Gateway projection stays reactive.
  const actions = untrack(() => props.actions);
  const now = new Date();
  const presets = resolveSessionSnoozePresets(now);
  const custom = createMemo(() => readCustomSnooze(actions.customSnoozeKey));
  const [error, setError] = createSignal(false);
  let anchor!: HTMLSpanElement;
  let input!: HTMLInputElement;
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
    popover?.overlay.bindTrigger(anchor.closest<HTMLElement>("wa-dropdown-item") ?? anchor);
    popover?.show();
  };
  const keydown = (event: KeyboardEvent) => {
    if (!popover?.overlay.open) {
      return false;
    }
    // Web Awesome dismisses the parent menu on Tab, so this dialog owns its controls.
    if (event.key === "Tab") {
      const controls = Array.from(
        popover.overlay.surface.querySelectorAll<HTMLElement>("input, button:not(:disabled)"),
      );
      const index = controls.findIndex((control) => control === document.activeElement);
      const next = (index + (event.shiftKey ? -1 : 1) + controls.length) % controls.length;
      event.preventDefault();
      event.stopPropagation();
      controls[next]?.focus();
      return true;
    }
    // The nested popover, not the parent menu, owns Escape and form key input.
    popover.overlay.keydown(event);
    return true;
  };
  const cancel = nativeListener("click", () => popover?.overlay.request(false, "return"));
  const stopClick = nativeListener("click", (event) => event.stopPropagation());
  const stopKeydown = nativeListener("keydown", (event) => event.stopPropagation());
  actions.openCustomSnooze = open;
  actions.customSnoozeKeydown = keydown;
  onCleanup(() => {
    if (actions.openCustomSnooze === open) {
      actions.openCustomSnooze = undefined;
    }
    if (actions.customSnoozeKeydown === keydown) {
      actions.customSnoozeKeydown = undefined;
    }
  });
  return (
    <>
      <For each={presets}>
        {(preset) => (
          <SessionMenuItem
            class="session-menu__item"
            slot={props.inline ? undefined : "submenu"}
            value={"snooze:" + preset.snoozedUntil}
            disabled={disabled()}
            title={props.state.actionDisabledReasons.snooze}
          >
            <span class="session-menu__text">
              {t(labels[preset.id])} ·{" "}
              {preset.id === "next-week"
                ? formatSessionSnoozeWakeTime(preset.snoozedUntil, now)
                : formatTimeMs(preset.snoozedUntil)}
            </span>
          </SessionMenuItem>
        )}
      </For>
      <Show when={custom() !== null}>
        <SessionMenuItem
          class="session-menu__item"
          slot={props.inline ? undefined : "submenu"}
          value="snooze-reuse"
          disabled={disabled()}
          title={props.state.actionDisabledReasons.snooze}
        >
          <span class="session-menu__text">
            {t("sessionsView.snoozeCustom")} · {formatCustomSnooze(custom()!)}
          </span>
        </SessionMenuItem>
      </Show>
      <SessionMenuItem
        class="session-menu__item"
        slot={props.inline ? undefined : "submenu"}
        value="snooze-custom"
        disabled={disabled()}
        title={props.state.actionDisabledReasons.snooze}
      >
        <span
          class="session-menu__text"
          ref={(node) => {
            anchor = node;
          }}
        >
          {t("sessionsView.snoozeChooseTime")}
        </span>
      </SessionMenuItem>
      <div slot={props.inline ? undefined : "submenu"}>
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
            ref={(form) => {
              stopClick(form);
              stopKeydown(form);
            }}
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
              <button type="button" class="btn" ref={cancel}>
                {t("common.cancel")}
              </button>
              <button type="submit" class="btn primary" disabled={disabled()}>
                {t("sessionsView.snooze")}
              </button>
            </div>
          </form>
        </Popover>
      </div>
    </>
  );
}
