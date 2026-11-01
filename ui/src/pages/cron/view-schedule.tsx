import { createMemo } from "solid-js";
import { Icon } from "../../components/solid/icon.tsx";
import {
  SettingsSection,
  SettingsRow,
  SettingsSegmented,
} from "../../components/solid/settings-ui.tsx";
import { parseCronDurationMs } from "../../lib/cron/decimal.ts";
import { hasUnchangedCronSchedule, parseCronScheduleAt } from "../../lib/cron/form-schedule.ts";
import type { CronFormState } from "../../lib/cron/types.ts";
import { formatMs } from "../../lib/format.ts";
import { t } from "../../lib/reactive/i18n.ts";
import { EventSourceFields } from "./view-event-source.tsx";
import {
  FieldRow,
  inputIdForField,
  errorIdForField,
  CronInput,
  CronSelect,
} from "./view-fields.tsx";
import { describeJobNextRun } from "./view-job-status.tsx";
import type { CronProps } from "./view-types.ts";
const EVERY_SUMMARY_KEYS = {
  seconds: ["cron.form.summaryEverySecondOne", "cron.form.summaryEverySeconds"],
  minutes: ["cron.form.summaryEveryMinuteOne", "cron.form.summaryEveryMinutes"],
  hours: ["cron.form.summaryEveryHourOne", "cron.form.summaryEveryHours"],
  days: ["cron.form.summaryEveryDayOne", "cron.form.summaryEveryDays"],
} as const;
// Human-readable schedule summary; null while invalid so it never disagrees with the saved value.
function describeFormSchedule(form: CronFormState): string | null {
  if (form.scheduleKind === "every") {
    const amount = form.everyAmount.trim();
    if (parseCronDurationMs(amount, form.everyUnit) === undefined) {
      return null;
    }
    const [singular, plural] = EVERY_SUMMARY_KEYS[form.everyUnit];
    return Number(amount) === 1 ? t(singular) : t(plural, { amount });
  }
  if (form.scheduleKind === "at") {
    const at = parseCronScheduleAt(form.scheduleAt);
    return at ? t("cron.form.summaryOnce", { at: formatMs(Date.parse(at)) }) : null;
  }
  if (form.scheduleKind === "cron") {
    const expr = form.cronExpr.trim();
    if (!expr) {
      return null;
    }
    const tz = form.cronTz.trim();
    return tz ? t("cron.form.summaryCronTz", { expr, tz }) : t("cron.form.summaryCron", { expr });
  }
  if (form.scheduleKind === "event") {
    return t("cron.events.summary", {
      server: form.eventServer,
      name: form.eventName || form.eventSource,
    });
  }
  if (form.scheduleKind === "on-exit") {
    return t("cron.form.repeatOnExit");
  }
  return form.scheduleKind === "stream" ? t("cron.form.repeatStream") : null;
}
export function DurationRow(
  props: CronProps & {
    kind: "every" | "stagger";
  },
) {
  const recurring = () => props.kind === "every";
  const amountField = () => (recurring() ? "everyAmount" : "staggerAmount");
  const unitField = () => (recurring() ? "everyUnit" : "staggerUnit");
  const label = () => t(recurring() ? "cron.form.every" : "cron.form.staggerWindow");
  const required = () => (recurring() ? true : undefined);
  const disabled = () => (recurring() ? undefined : props.form.scheduleExact);
  const units = () =>
    recurring() ? ["seconds", "minutes", "hours", "days"] : ["seconds", "minutes"];
  return (
    <FieldRow
      label={label()}
      controlId={inputIdForField(amountField())}
      required={required()}
      error={props.fieldErrors[amountField()]}
      errorId={errorIdForField(amountField())}
      control={
        <div class="cron-inline-controls">
          <CronInput
            {...props}
            field={amountField()}
            inline
            label={label()}
            required={required()}
            disabled={disabled()}
            errorKey={amountField()}
            placeholder={t(
              recurring() ? "cron.form.everyAmountPlaceholder" : "cron.form.staggerPlaceholder",
            )}
          />
          <CronSelect
            {...props}
            field={unitField()}
            label={t(recurring() ? "cron.form.unit" : "cron.form.staggerUnit")}
            inline
            disabled={disabled()}
            options={units().map((value) => ({ value, label: t(`cron.form.${value}`) }))}
          />
        </div>
      }
    />
  );
}
export function ScheduleSection(props: CronProps) {
  const form = () => props.form;
  const isOnExit = () => form().scheduleKind === "on-exit";
  const isStream = () => form().scheduleKind === "stream";
  // Process-backed schedules stay selectable only while current: jobs can
  // convert to an editable schedule, but never synthesize a command in the UI.
  const processSchedule = () =>
    isOnExit()
      ? { value: "on-exit" as const, label: t("cron.form.repeatOnExit") }
      : isStream()
        ? { value: "stream" as const, label: t("cron.form.repeatStream") }
        : null;
  const kinds = (): Array<{
    value: CronFormState["scheduleKind"];
    label: string;
    testId: string;
  }> => {
    const process = processSchedule();
    return [
      ...(process ? [{ ...process, testId: `cron-schedule-kind-${process.value}` }] : []),
      { value: "every", label: t("cron.form.repeatInterval"), testId: "cron-schedule-kind-every" },
      { value: "at", label: t("cron.form.repeatOnce"), testId: "cron-schedule-kind-at" },
      { value: "cron", label: t("cron.form.cronOption"), testId: "cron-schedule-kind-cron" },
      ...((props.eventSource?.available && props.status?.triggersEnabled !== false) ||
      form().scheduleKind === "event"
        ? [
            {
              value: "event" as const,
              label: t("cron.events.label"),
              testId: "cron-schedule-kind-event",
            },
          ]
        : []),
    ];
  };
  // The form owns the authored occurrence; runtime deadlines may move after
  // a continuation or retry. Never copy that deadline into the editable time.
  const savedOneShot = createMemo(
    () => {
      const job = props.editingJob;
      return job?.schedule.kind === "at" && hasUnchangedCronSchedule(form(), job) ? job : undefined;
    },
    { equals: false },
  );
  const summary = createMemo(() => {
    const job = savedOneShot();
    return job?.schedule.kind === "at"
      ? t("cron.form.summaryConfiguredAt", { at: formatMs(Date.parse(job.schedule.at)) })
      : describeFormSchedule(form());
  });
  const runtimeSummary = () => {
    const job = savedOneShot();
    return job ? describeJobNextRun(job, true) : null;
  };
  return (
    <SettingsSection title={t("cron.detail.scheduleSection")}>
      <SettingsRow
        title={t("cron.form.repeat")}
        description={isOnExit() ? t("cron.form.onExitHelp") : undefined}
        stacked
        control={
          <SettingsSegmented<CronFormState["scheduleKind"]>
            value={form().scheduleKind}
            options={kinds()}
            ariaLabel={t("cron.form.repeat")}
            onChange={(value) =>
              props.onFormChange({
                scheduleKind: value,
                ...(value === "event" ? { triggerEnabled: false, deleteAfterRun: false } : {}),
                ...(value === "at" &&
                (form().scheduleKind === "every" || form().scheduleKind === "cron")
                  ? { deleteAfterRun: true }
                  : value === "every" || value === "cron"
                    ? { deleteAfterRun: false }
                    : {}),
              })
            }
          />
        }
      />
      {form().scheduleKind === "at" ? (
        <CronInput
          {...props}
          field="scheduleAt"
          label={t(
            props.editingJob?.schedule.kind === "at"
              ? "cron.form.configuredTime"
              : "cron.form.runAt",
          )}
          required
          errorKey="scheduleAt"
          type="datetime-local"
        />
      ) : undefined}
      {form().scheduleKind === "every" ? <DurationRow {...props} kind="every" /> : undefined}
      {form().scheduleKind === "cron" ? (
        <>
          <CronInput
            {...props}
            field="cronExpr"
            label={t("cron.form.expression")}
            required
            errorKey="cronExpr"
            mono
            placeholder={t("cron.form.expressionPlaceholder")}
          />
          <CronInput
            {...props}
            field="cronTz"
            errorKey="cronTz"
            label={t("cron.form.timezoneOptional")}
            help={t("cron.form.timezoneHelp")}
            list="cron-tz-suggestions"
            placeholder={t("cron.form.timezonePlaceholder")}
          />
        </>
      ) : undefined}
      {form().scheduleKind === "event" ? <EventSourceFields {...props} /> : undefined}
      {summary() ? (
        <div class="cron-schedule-summary">
          <Icon name="clock" />
          <span>
            {summary()}
            {runtimeSummary() ? (
              <>
                {" · "}
                <strong>{runtimeSummary()}</strong>
              </>
            ) : undefined}
          </span>
        </div>
      ) : undefined}
    </SettingsSection>
  );
}
