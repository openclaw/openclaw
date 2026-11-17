import type { JSX } from "@solidjs/web";
import { createUniqueId, For, Show } from "solid-js";
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
  testId: string;
  /** Receives a way to close the menu once a single choice is made. */
  children: (close: () => void) => JSX.Element;
}) {
  let handle: PopoverHandle | undefined;
  return (
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
  step?: number;
  testId: string;
  onChange: (hour: number, minute: number) => void;
}) {
  return (
    <label class="cron-sentence__field">
      <span>{props.label}</span>
      <input
        type="time"
        step={props.step ?? 60}
        data-test-id={props.testId}
        value={`${pad(props.hour)}:${pad(props.minute)}`}
        onChange={(event) => {
          const match = /^(\d{2}):(\d{2})/u.exec(event.currentTarget.value);
          if (match) {
            props.onChange(Number(match[1]), Number(match[2]));
          }
        }}
      />
    </label>
  );
}

/** The schedule as a sentence over the existing schedule fields; Custom keeps the expression. */
export function ScheduleSentence(
  props: CronProps & {
    frequency: SentenceFrequency;
    kinds: Kind[];
    onCustom: (custom: boolean) => void;
  },
) {
  const id = createUniqueId();
  const sentence = (): CronSentence | null =>
    props.form.scheduleKind === "cron" && props.frequency !== "custom"
      ? parseCronSentence(props.form.cronExpr)
      : null;
  const eventKind = () => props.kinds.find((kind) => kind.value === "event");
  const writeCron = (next: CronSentence) =>
    props.onFormChange({ cronExpr: formatCronSentence(next) });
  const chooseFrequency = (frequency: SentenceFrequency) => {
    props.onCustom(frequency === "custom");
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
      writeCron({ ...current, days });
    }
  };
  type Of<F extends CronSentence["frequency"]> = Extract<CronSentence, { frequency: F }>;
  // Parts stay mounted while the frequency holds, so their menus stay open across edits.
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
                text={t("cron.schedule.onDays", { days: daysLabel(withDays().days) })}
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
                text={t("cron.schedule.onDays", { days: weekdayName(weekly().day, "long") })}
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
                text={t("cron.schedule.onDayOfMonth", { day: String(monthly().dayOfMonth) })}
                testId="cron-schedule-date"
              >
                {() => (
                  <label class="cron-sentence__field">
                    <span>{t("cron.schedule.dayOfMonth")}</span>
                    <input
                      type="number"
                      min="1"
                      max="31"
                      data-test-id="cron-schedule-date-input"
                      value={monthly().dayOfMonth}
                      onChange={(event) => {
                        const value = Number(event.currentTarget.value);
                        if (Number.isInteger(value) && value >= 1 && value <= 31) {
                          writeCron({ ...monthly(), dayOfMonth: value });
                        }
                      }}
                    />
                  </label>
                )}
              </Part>
            ) : undefined}
            {frequency === "hourly" ? (
              <Part
                id={`${id}-hours`}
                label={t("cron.schedule.hours")}
                text={(() => {
                  const hours = hourly().hours;
                  return hours
                    ? t("cron.schedule.between", {
                        from: timeLabel(hours.from),
                        until: timeLabel(hours.until),
                      })
                    : t("cron.schedule.allDay");
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
                          <TimeInput
                            label={t("cron.schedule.from")}
                            hour={hours().from}
                            minute={0}
                            step={3600}
                            testId="cron-schedule-from"
                            onChange={(hour) => {
                              if (hour < hours().until) {
                                writeCron({ ...hourly(), hours: { ...hours(), from: hour } });
                              }
                            }}
                          />
                          <TimeInput
                            label={t("cron.schedule.until")}
                            hour={hours().until}
                            minute={0}
                            step={3600}
                            testId="cron-schedule-until"
                            onChange={(hour) => {
                              if (hour > hours().from) {
                                writeCron({ ...hourly(), hours: { ...hours(), until: hour } });
                              }
                            }}
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
                text={t("cron.schedule.atTime", {
                  time: timeLabel(timed().hour, timed().minute),
                })}
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
