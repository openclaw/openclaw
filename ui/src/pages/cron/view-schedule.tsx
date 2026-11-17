import { createMemo, createSignal, For } from "solid-js";
import { SettingsSegmented } from "../../components/solid/settings-ui.tsx";
import { parseCronDurationMs } from "../../lib/cron/decimal.ts";
import { hasUnchangedCronSchedule, parseCronScheduleAt } from "../../lib/cron/form-schedule.ts";
import type { CronFieldKey, CronFormState } from "../../lib/cron/types.ts";
import { formatMs } from "../../lib/format.ts";
import { t } from "../../lib/reactive/i18n.ts";
import { formSentenceFrequency, scheduleKindPatch } from "./schedule-sentence.ts";
import { EventSourceFields } from "./view-event-source.tsx";
import {
  FieldRow,
  inputIdForField,
  errorIdForField,
  CronInput,
  CronSelect,
  TrayInput,
} from "./view-fields.tsx";
import { describeJobNextRun } from "./view-job-status.tsx";
import { ScheduleSentence } from "./view-schedule-sentence.tsx";
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
/** Schedule fields whose validation messages the tray lists under its controls. */
export const TRAY_SCHEDULE_FIELDS = ["scheduleAt", "everyAmount", "cronExpr", "cronTz"] as const;
/** The Repeat choice and its per-kind fields, compact enough to share the prompt's tray. */
export function ScheduleControls(props: CronProps) {
  const form = () => props.form;
  // Weekly and single-day Daily have the same expression. Keep the editor's
  // explicit mode for this draft, without adding a field to the saved schedule.
  const [preference, setPreference] = createSignal<{
    jobId: string | undefined;
    mode: "custom" | "daily";
  }>();
  const frequency = createMemo(() => {
    const read = formSentenceFrequency(form());
    const current = preference();
    if (form().scheduleKind !== "cron" || !current || current.jobId !== props.editingJob?.id) {
      return read;
    }
    if (current.mode === "custom") {
      return "custom";
    }
    return read === "weekly" ? "daily" : read;
  });
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
  return (
    <>
      {frequency() ? (
        <ScheduleSentence
          {...props}
          frequency={frequency()!}
          kinds={kinds()}
          onFrequencyPreference={(mode) =>
            setPreference(mode ? { jobId: props.editingJob?.id, mode } : undefined)
          }
        />
      ) : (
        <SettingsSegmented<CronFormState["scheduleKind"]>
          class="settings-segmented--compact cron-tray-segmented"
          value={form().scheduleKind}
          options={kinds()}
          ariaLabel={t("cron.form.repeat")}
          onChange={(value) => props.onFormChange(scheduleKindPatch(form(), value))}
        />
      )}
      {form().scheduleKind === "at" ? (
        <TrayInput
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
      {form().scheduleKind === "every" ? (
        <span class="cron-tray-pair">
          <TrayInput
            {...props}
            field="everyAmount"
            label={t("cron.form.every")}
            required
            errorKey="everyAmount"
            size="narrow"
            placeholder={t("cron.form.everyAmountPlaceholder")}
          />
          <span class="cron-tray-picker">
            <CronSelect
              {...props}
              field="everyUnit"
              label={t("cron.form.unit")}
              inline
              options={["seconds", "minutes", "hours", "days"].map((value) => ({
                value,
                label: t(`cron.form.${value}`),
              }))}
            />
          </span>
        </span>
      ) : undefined}
      {form().scheduleKind === "cron" && frequency() === "custom" ? (
        <>
          <TrayInput
            {...props}
            field="cronExpr"
            label={t("cron.form.expression")}
            required
            errorKey="cronExpr"
            mono
            placeholder={t("cron.form.expressionPlaceholder")}
          />
          <TrayInput
            {...props}
            field="cronTz"
            errorKey="cronTz"
            label={t("cron.form.timezoneOptional")}
            help={t("cron.form.timezoneHelp")}
            size="wide"
            list="cron-tz-suggestions"
            placeholder={t("cron.form.timezonePlaceholder")}
          />
        </>
      ) : undefined}
    </>
  );
}
/** Validation messages for the tray's own fields, listed under its controls. */
export function TrayErrors(props: Pick<CronProps, "fieldErrors"> & { fields: CronFieldKey[] }) {
  const errors = createMemo(() =>
    props.fields.flatMap((field) => {
      const message = props.fieldErrors[field];
      return message ? [{ field, message }] : [];
    }),
  );
  return (
    <For each={errors()} keyed={(error) => error.field}>
      {(error) => (
        <div id={errorIdForField(error().field)} class="cron-help cron-error" role="alert">
          {t(error().message)}
        </div>
      )}
    </For>
  );
}
/** The form's live schedule in words, with the saved one-shot's runtime facts. */
export function ScheduleSummary(props: CronProps) {
  const form = () => props.form;
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
    <>
      {summary() ? (
        <div class="cron-schedule-summary">
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
    </>
  );
}
/** Schedule settings too large for the tray: the event source and process-backed notes. */
export function ScheduleDetails(props: CronProps) {
  return (
    <>
      {props.form.scheduleKind === "on-exit" ? (
        <p class="cron-help cron-schedule-note">{t("cron.form.onExitHelp")}</p>
      ) : undefined}
      {props.form.scheduleKind === "event" ? (
        <div class="settings-group cron-editor-card" data-test-id="cron-event-source">
          <EventSourceFields {...props} />
        </div>
      ) : undefined}
    </>
  );
}
