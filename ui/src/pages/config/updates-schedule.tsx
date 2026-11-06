import { createMemo, createSignal, For, Show } from "solid-js";
import { SettingsRow, SettingsSegmented } from "../../components/solid/settings-ui.tsx";
import { t } from "../../lib/reactive/i18n.ts";
import { liveValue } from "../../lib/reactive/live-value.ts";

type Preset = "hourly" | "daily" | "weekly" | "custom";

function readSchedule(expression: string | undefined): {
  preset: Preset;
  time: string;
  day: string;
} {
  if (expression === undefined) {
    return { preset: "hourly", time: "03:00", day: "0" };
  }
  const fields = expression.trim().split(/\s+/);
  const [minute, hour, date, month, day] = fields;
  if (
    fields.length === 5 &&
    /^\d+$/.test(minute!) &&
    /^\d+$/.test(hour!) &&
    Number(minute) < 60 &&
    Number(hour) < 24 &&
    date === "*" &&
    month === "*" &&
    (day === "*" || /^[0-6]$/.test(day!))
  ) {
    return {
      preset: day === "*" ? "daily" : "weekly",
      time: `${hour!.padStart(2, "0")}:${minute!.padStart(2, "0")}`,
      day: day === "*" ? "0" : day!,
    };
  }
  return { preset: "custom", time: "03:00", day: "0" };
}

export function UpdatesSchedule(props: {
  expression: string | undefined;
  disabled: boolean;
  onChange: (expression: string | undefined) => void;
}) {
  const parsed = createMemo(() => readSchedule(props.expression));
  // Custom is an editing mode, not another persisted representation. Preserve it
  // while typing a cron expression that happens to match one of the presets.
  const [custom, setCustom] = createSignal(false);
  const preset = () => (custom() ? "custom" : parsed().preset);
  const expression = createMemo(() => props.expression ?? "0 * * * *");
  const time = createMemo(() => parsed().time);
  const day = createMemo(() => parsed().day);
  const saveTime = (value: string, weekday = parsed().day) => {
    if (!/^\d{2}:\d{2}$/.test(value)) {
      return;
    }
    const [hour, minute] = value.split(":").map(Number);
    props.onChange(`${minute} ${hour} * * ${preset() === "weekly" ? weekday : "*"}`);
  };
  const choose = (value: Preset) => {
    setCustom(value === "custom");
    if (value === "custom") {
      return;
    }
    if (value === "hourly") {
      props.onChange(undefined);
      return;
    }
    const [hour, minute] = parsed().time.split(":").map(Number);
    props.onChange(`${minute} ${hour} * * ${value === "weekly" ? parsed().day : "*"}`);
  };
  return (
    <>
      <SettingsRow
        title={t("updates.page.schedule")}
        description={t("updates.page.scheduleDescription")}
        stacked
        control={
          <SettingsSegmented
            value={preset()}
            disabled={props.disabled}
            ariaLabel={t("updates.page.schedule")}
            options={(["hourly", "daily", "weekly", "custom"] as const).map((value) => ({
              value,
              label: t(`updates.page.schedulePreset.${value}`),
            }))}
            onChange={choose}
          />
        }
      />
      <Show when={preset() === "daily" || preset() === "weekly"}>
        <SettingsRow
          title={t("updates.page.scheduleTime")}
          control={
            <input
              type="time"
              class="settings-input"
              aria-label={t("updates.page.scheduleTime")}
              disabled={props.disabled}
              ref={liveValue(time)}
              onChange={(event) => saveTime(event.currentTarget.value)}
            />
          }
        />
      </Show>
      <Show when={preset() === "weekly"}>
        <SettingsRow
          title={t("updates.page.scheduleDay")}
          control={
            <select
              class="settings-input"
              aria-label={t("updates.page.scheduleDay")}
              disabled={props.disabled}
              ref={liveValue(day)}
              onChange={(event) => saveTime(time(), event.currentTarget.value)}
            >
              <For each={["0", "1", "2", "3", "4", "5", "6"]}>
                {(value) => (
                  <option value={value}>{t(`updates.page.scheduleWeekday.${value}`)}</option>
                )}
              </For>
            </select>
          }
        />
      </Show>
      <Show when={preset() === "custom"}>
        <SettingsRow
          title={t("updates.page.scheduleCron")}
          description={t("updates.page.scheduleCronHint")}
          stacked
          control={
            <input
              type="text"
              class="settings-input"
              aria-label={t("updates.page.scheduleCron")}
              disabled={props.disabled}
              ref={liveValue(expression)}
              spellcheck="false"
              onChange={(event) => props.onChange(event.currentTarget.value.trim())}
            />
          }
        />
      </Show>
    </>
  );
}
