import type { JSX } from "@solidjs/web";
import { createMemo, createUniqueId, For, Show } from "solid-js";
import { Icon } from "../../components/solid/icon.tsx";
import { Popover, type PopoverHandle } from "../../components/solid/popover.tsx";
import { i18n } from "../../i18n/index.ts";
import type { CronFormState } from "../../lib/cron/types.ts";
import { t } from "../../lib/reactive/i18n.ts";
import {
  ALL_DAYS,
  formatCronSentence,
  parseCronSentence,
  scheduleKindPatch,
  sentenceForFrequency,
  WEEKDAYS,
  WEEKEND,
  type CronSentence,
  type SentenceFrequency,
} from "./schedule-sentence.ts";
import type { CronProps } from "./view-types.ts";

type Kind = { value: CronFormState["scheduleKind"]; label: string; testId: string };

const FREQUENCIES: SentenceFrequency[] = [
  "daily",
  "hourly",
  "weekly",
  "monthly",
  "every",
  "once",
  "custom",
];

// 2023-01-01 was a Sunday, so day n of that week is cron weekday n.
const weekdayDate = (day: number) => new Date(2023, 0, 1 + day);
const timeDate = (hour: number, minute = 0) => new Date(2023, 0, 1, hour, minute);
const pad = (value: number) => String(value).padStart(2, "0");

function weekdayName(day: number, style: "short" | "long" | "narrow") {
  return new Intl.DateTimeFormat(i18n.getLocale(), { weekday: style }).format(weekdayDate(day));
}

function timeLabel(hour: number, minute = 0) {
  return new Intl.DateTimeFormat(i18n.getLocale(), { hour: "numeric", minute: "2-digit" }).format(
    timeDate(hour, minute),
  );
}

function sameDays(days: readonly number[], expected: readonly number[]) {
  return days.length === expected.length && expected.every((day) => days.includes(day));
}

function daysLabel(days: readonly number[]) {
  if (sameDays(days, ALL_DAYS)) {
    return t("cron.schedule.everyDay");
  }
  if (sameDays(days, WEEKDAYS)) {
    return t("cron.schedule.weekdays");
  }
  if (sameDays(days, WEEKEND)) {
    return t("cron.schedule.weekend");
  }
  return new Intl.ListFormat(i18n.getLocale(), { style: "narrow", type: "conjunction" }).format(
    days.map((day) => weekdayName(day, "short")),
  );
}

/** One part of the sentence: its words as a text button, its choices in a small menu. */
function Part(props: {
  id: string;
  label: string;
  text: string;
  rowLabel?: string;
  testId: string;
  /** Receives a way to close the menu once a single choice is made. */
  children: (close: () => void) => JSX.Element;
}) {
  let handle: PopoverHandle | undefined;
  return (
    <span class="cron-sentence__row">
      <span class="cron-sentence__label" aria-hidden="true">
        {props.rowLabel ?? props.label}
      </span>
      <Popover
        ref={(next) => {
          handle = next;
        }}
        id={`${props.id}-menu`}
        triggerId={props.id}
        triggerClass="cron-sentence__part"
        triggerAriaLabel={`${props.label}: ${props.text}`}
        trigger={
          <span class="cron-sentence__text" data-test-id={props.testId}>
            {props.text}
            <Icon name="chevronDown" />
          </span>
        }
        class="cron-sentence__menu"
        placement="bottom-start"
        label={props.label}
      >
        {props.children(() => handle?.hide())}
      </Popover>
    </span>
  );
}

function Choice(props: {
  selected: boolean;
  label: string;
  testId?: string;
  onSelect: () => void;
}) {
  return (
    <button
      type="button"
      class="cron-sentence__choice"
      aria-pressed={props.selected ? "true" : "false"}
      data-test-id={props.testId}
      onClick={() => props.onSelect()}
    >
      {props.label}
    </button>
  );
}

function TimeInput(props: {
  label: string;
  hour: number;
  minute: number;
  testId: string;
  onChange: (hour: number, minute: number) => void;
}) {
  return (
    <label class="cron-sentence__field">
      <span>{props.label}</span>
      <input
        type="time"
        step={60}
        data-test-id={props.testId}
        value={`${pad(props.hour)}:${pad(props.minute)}`}
        onChange={(event) => {
          const match = /^(\d{2}):(\d{2})$/u.exec(event.currentTarget.value);
          if (match) {
            props.onChange(Number(match[1]), Number(match[2]));
          } else {
            event.currentTarget.value = `${pad(props.hour)}:${pad(props.minute)}`;
          }
        }}
      />
    </label>
  );
}

function NumberChoice(props: {
  label: string;
  value: number;
  min: number;
  max: number;
  text: (value: number) => string;
  testId: string;
  onChange: (value: number) => void;
}) {
  const values = createMemo(() => {
    const min = props.min;
    return Array.from({ length: props.max - min + 1 }, (_, index) => min + index);
  });
  return (
    <label class="cron-sentence__field">
      <span>{props.label}</span>
      <select
        data-test-id={props.testId}
        onChange={(event) => props.onChange(Number(event.currentTarget.value))}
      >
        <For each={values()}>
          {(value) => (
            <option value={value} selected={value === props.value}>
              {props.text(value)}
            </option>
          )}
        </For>
      </select>
    </label>
  );
}

/** The schedule as a sentence over the existing schedule fields; Custom keeps the expression. */
export function ScheduleSentence(
  props: CronProps & {
    frequency: SentenceFrequency;
    phoneLayout: boolean;
    kinds: Kind[];
    onFrequencyPreference: (mode: "custom" | "daily" | null) => void;
  },
) {
  const id = createUniqueId();
  const sentence = createMemo((): CronSentence | null => {
    if (props.form.scheduleKind !== "cron" || props.frequency === "custom") {
      return null;
    }
    const parsed = parseCronSentence(props.form.cronExpr);
    if (props.frequency === "daily" && parsed?.frequency === "weekly") {
      return { frequency: "daily", days: [parsed.day], hour: parsed.hour, minute: parsed.minute };
    }
    return parsed;
  });
  const eventKind = () => props.kinds.find((kind) => kind.value === "event");
  const writeCron = (next: CronSentence) =>
    props.onFormChange({ cronExpr: formatCronSentence(next) });
  const chooseFrequency = (frequency: SentenceFrequency) => {
    props.onFrequencyPreference(frequency === "custom" || frequency === "daily" ? frequency : null);
    if (frequency === "once") {
      props.onFormChange(scheduleKindPatch(props.form, "at"));
      return;
    }
    if (frequency === "every") {
      props.onFormChange(scheduleKindPatch(props.form, "every"));
      return;
    }
    if (frequency === "custom") {
      if (props.form.scheduleKind !== "cron") {
        props.onFormChange(scheduleKindPatch(props.form, "cron"));
      }
      return;
    }
    const current =
      props.form.scheduleKind === "cron" ? parseCronSentence(props.form.cronExpr) : null;
    props.onFormChange({
      ...(props.form.scheduleKind === "cron" ? {} : scheduleKindPatch(props.form, "cron")),
      cronExpr: formatCronSentence(sentenceForFrequency(frequency, current)),
    });
  };
  const toggleDay = (current: Extract<CronSentence, { days: number[] }>, day: number) => {
    const days = current.days.includes(day)
      ? current.days.filter((value) => value !== day)
      : [...current.days, day];
    // A sentence always names at least one day.
    if (days.length > 0) {
      if (current.frequency === "daily") {
        props.onFrequencyPreference("daily");
      }
      writeCron({ ...current, days });
    }
  };
  type Of<F extends CronSentence["frequency"]> = Extract<CronSentence, { frequency: F }>;
  // Parts stay mounted while the frequency holds, so their menus stay open across edits.
  // SAFETY: Each accessor is used only in its matching branch of the Show keyed by sentence frequency.
  const as = <F extends CronSentence["frequency"]>() => sentence() as Of<F>;
  const withDays = () => as<"hourly" | "daily">();
  const timed = () => as<"daily" | "weekly" | "monthly">();
  const hourly = () => as<"hourly">();
  const weekly = () => as<"weekly">();
  const monthly = () => as<"monthly">();
  return (
    <span class="cron-sentence" role="group" aria-label={t("cron.form.repeat")}>
      <Part
        id={`${id}-frequency`}
        label={t("cron.form.repeat")}
        text={t(`cron.schedule.${props.frequency}`)}
        testId="cron-schedule-frequency"
      >
        {(close) => (
          <div class="cron-sentence__choices" role="group" aria-label={t("cron.form.repeat")}>
            <For each={FREQUENCIES}>
              {(frequency) => (
                <Choice
                  selected={props.frequency === frequency}
                  label={t(`cron.schedule.${frequency}`)}
                  testId={`cron-schedule-frequency-${frequency}`}
                  onSelect={() => {
                    chooseFrequency(frequency);
                    close();
                  }}
                />
              )}
            </For>
            <Show when={eventKind()}>
              {(kind) => (
                <Choice
                  selected={false}
                  label={kind().label}
                  testId="cron-schedule-frequency-event"
                  onSelect={() => {
                    props.onFrequencyPreference(null);
                    props.onFormChange(scheduleKindPatch(props.form, "event"));
                    close();
                  }}
                />
              )}
            </Show>
          </div>
        )}
      </Part>
      <Show when={sentence()?.frequency} keyed>
        {(frequency) => (
          <>
            {frequency === "hourly" || frequency === "daily" ? (
              <Part
                id={`${id}-days`}
                label={t("cron.schedule.days")}
                rowLabel={t("cron.schedule.on")}
                text={
                  props.phoneLayout
                    ? daysLabel(withDays().days)
                    : t("cron.schedule.onDays", { days: daysLabel(withDays().days) })
                }
                testId="cron-schedule-days"
              >
                {() => (
                  <div
                    class="cron-sentence__days"
                    role="group"
                    aria-label={t("cron.schedule.days")}
                  >
                    <For each={[...ALL_DAYS]}>
                      {(day) => (
                        <button
                          type="button"
                          class="cron-sentence__day"
                          aria-pressed={withDays().days.includes(day) ? "true" : "false"}
                          aria-label={weekdayName(day, "long")}
                          data-test-id={`cron-schedule-day-${day}`}
                          onClick={() => toggleDay(withDays(), day)}
                        >
                          {weekdayName(day, "narrow")}
                        </button>
                      )}
                    </For>
                  </div>
                )}
              </Part>
            ) : undefined}
            {frequency === "weekly" ? (
              <Part
                id={`${id}-day`}
                label={t("cron.schedule.day")}
                rowLabel={t("cron.schedule.on")}
                text={
                  props.phoneLayout
                    ? weekdayName(weekly().day, "long")
                    : t("cron.schedule.onDays", { days: weekdayName(weekly().day, "long") })
                }
                testId="cron-schedule-day"
              >
                {(close) => (
                  <div
                    class="cron-sentence__choices"
                    role="group"
                    aria-label={t("cron.schedule.day")}
                  >
                    <For each={[1, 2, 3, 4, 5, 6, 0]}>
                      {(day) => (
                        <Choice
                          selected={weekly().day === day}
                          label={weekdayName(day, "long")}
                          testId={`cron-schedule-weekday-${day}`}
                          onSelect={() => {
                            writeCron({ ...weekly(), day });
                            close();
                          }}
                        />
                      )}
                    </For>
                  </div>
                )}
              </Part>
            ) : undefined}
            {frequency === "monthly" ? (
              <Part
                id={`${id}-date`}
                label={t("cron.schedule.dayOfMonth")}
                rowLabel={t("cron.schedule.onThe")}
                text={
                  props.phoneLayout
                    ? String(monthly().dayOfMonth)
                    : t("cron.schedule.onDayOfMonth", { day: String(monthly().dayOfMonth) })
                }
                testId="cron-schedule-date"
              >
                {() => (
                  <NumberChoice
                    label={t("cron.schedule.dayOfMonth")}
                    value={monthly().dayOfMonth}
                    min={1}
                    max={31}
                    text={String}
                    testId="cron-schedule-date-input"
                    onChange={(dayOfMonth) => writeCron({ ...monthly(), dayOfMonth })}
                  />
                )}
              </Part>
            ) : undefined}
            {frequency === "hourly" ? (
              <Part
                id={`${id}-hours`}
                label={t("cron.schedule.hours")}
                rowLabel={t(hourly().hours ? "cron.schedule.betweenLabel" : "cron.schedule.hours")}
                text={(() => {
                  const hours = hourly().hours;
                  if (!hours) {
                    return t("cron.schedule.allDay");
                  }
                  const from = timeLabel(hours.from);
                  const until = timeLabel(hours.until);
                  return props.phoneLayout
                    ? `${from} – ${until}`
                    : t("cron.schedule.between", { from, until });
                })()}
                testId="cron-schedule-hours"
              >
                {(close) => (
                  <>
                    <div
                      class="cron-sentence__choices"
                      role="group"
                      aria-label={t("cron.schedule.hours")}
                    >
                      <Choice
                        selected={!hourly().hours}
                        label={t("cron.schedule.allDayOption")}
                        testId="cron-schedule-all-day"
                        onSelect={() => {
                          writeCron({ ...hourly(), hours: null });
                          close();
                        }}
                      />
                      <Choice
                        selected={Boolean(hourly().hours)}
                        label={t("cron.schedule.betweenOption")}
                        testId="cron-schedule-between"
                        onSelect={() =>
                          writeCron({
                            ...hourly(),
                            hours: hourly().hours ?? { from: 9, until: 17 },
                          })
                        }
                      />
                    </div>
                    <Show when={hourly().hours}>
                      {(hours) => (
                        <div class="cron-sentence__range">
                          <NumberChoice
                            label={t("cron.schedule.from")}
                            value={hours().from}
                            min={0}
                            max={hours().until - 1}
                            text={timeLabel}
                            testId="cron-schedule-from"
                            onChange={(from) =>
                              writeCron({ ...hourly(), hours: { ...hours(), from } })
                            }
                          />
                          <NumberChoice
                            label={t("cron.schedule.until")}
                            value={hours().until}
                            min={hours().from + 1}
                            max={23}
                            text={timeLabel}
                            testId="cron-schedule-until"
                            onChange={(until) =>
                              writeCron({ ...hourly(), hours: { ...hours(), until } })
                            }
                          />
                        </div>
                      )}
                    </Show>
                  </>
                )}
              </Part>
            ) : (
              <Part
                id={`${id}-time`}
                label={t("cron.schedule.time")}
                rowLabel={t("cron.form.at")}
                text={
                  props.phoneLayout
                    ? timeLabel(timed().hour, timed().minute)
                    : t("cron.schedule.atTime", { time: timeLabel(timed().hour, timed().minute) })
                }
                testId="cron-schedule-time"
              >
                {() => (
                  <TimeInput
                    label={t("cron.schedule.time")}
                    hour={timed().hour}
                    minute={timed().minute}
                    testId="cron-schedule-time-input"
                    onChange={(hour, minute) => writeCron({ ...timed(), hour, minute })}
                  />
                )}
              </Part>
            )}
          </>
        )}
      </Show>
    </span>
  );
}
