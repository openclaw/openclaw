import { createMemo, createSignal, For } from "solid-js";
import { SettingsSegmented } from "../../components/solid/settings-ui.tsx";
import { hasUnchangedCronSchedule } from "../../lib/cron/form-schedule.ts";
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
import { ScheduleHours, ScheduleSentence } from "./view-schedule-sentence.tsx";
import type { CronProps } from "./view-types.ts";
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
export const TRAY_SCHEDULE_FIELDS = [
  "scheduleAt",
  "everyAmount",
  "cronExpr",
  "cronTz",
  "activeHoursStart",
  "activeHoursEnd",
] as const;
/** The Repeat choice and its per-kind fields, compact enough to share the prompt's tray. */
export function ScheduleControls(props: CronProps & { phoneLayout: boolean }) {
  const form = () => props.form;
  // Weekly and single-day Daily have the same expression. Keep the editor's
  // explicit mode for this draft, without adding a field to the saved schedule.
  const [preference, setPreference] = createSignal<{
    jobId: string | undefined;
    mode: "custom" | "daily";
  }>();
  const preferFrequency = (mode: "custom" | "daily" | null) => {
    const jobId = props.editingJob?.id;
    setPreference((current) =>
      mode
        ? current?.jobId === jobId && current?.mode === mode
          ? current
          : { jobId, mode }
        : undefined,
    );
  };
  const frequency = createMemo(() => {
    const draft = form();
    const current = preference();
    const preferredMode =
      draft.scheduleKind === "cron" && current?.jobId === props.editingJob?.id
        ? current?.mode
        : undefined;
    if (preferredMode === "custom") {
      return "custom";
    }
    const read = formSentenceFrequency(draft);
    return preferredMode === "daily" && read === "weekly" ? "daily" : read;
  });
  const showHours = () =>
    form().scheduleKind === "cron" || form().scheduleKind === "every" || form().activeHoursEnabled;
  const savedHoursZone = createMemo(() => {
    const job = props.editingJob;
    if (
      !form().activeHoursEnabled ||
      form().scheduleKind !== "cron" ||
      job?.schedule.kind !== "cron" ||
      !job.activeHours ||
      form().cronTz.trim() !== (job.schedule.tz ?? "")
    ) {
      return undefined;
    }
    const zone = job.activeHours.timezone ?? "user";
    return zone === (job.schedule.tz ?? "local") ? undefined : zone;
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
          onFrequencyPreference={preferFrequency}
          phoneLayout={props.phoneLayout}
        />
      ) : (
        <span class="cron-sentence__row">
          <span class="cron-sentence__label" aria-hidden="true">
            {t("cron.form.repeat")}
          </span>
          <SettingsSegmented<CronFormState["scheduleKind"]>
            class="settings-segmented--compact cron-tray-segmented"
            value={form().scheduleKind}
            options={kinds()}
            ariaLabel={t("cron.form.repeat")}
            onChange={(value) => props.onFormChange(scheduleKindPatch(form(), value))}
          />
        </span>
      )}
      {form().scheduleKind === "at" ? (
        <span class="cron-sentence__row">
          <span class="cron-sentence__label" aria-hidden="true">
            {t("cron.form.at")}
          </span>
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
        </span>
      ) : undefined}
      {form().scheduleKind === "every" ? (
        <span class="cron-sentence__row">
          <span class="cron-sentence__label" aria-hidden="true">
            {t("cron.form.every")}
          </span>
          <span class="cron-tray-pair">
            <TrayInput
              {...props}
              field="everyAmount"
              label={t("cron.form.every")}
              required
              errorKey="everyAmount"
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
        </span>
      ) : undefined}
      {form().scheduleKind === "cron" && frequency() === "custom" ? (
        <span class="cron-sentence__row">
          <span class="cron-sentence__label" aria-hidden="true">
            {t("cron.form.expression")}
          </span>
          <TrayInput
            {...props}
            field="cronExpr"
            onFormChange={(patch) => {
              // An inferred Custom mode becomes explicit as soon as the expression is edited.
              preferFrequency("custom");
              props.onFormChange(patch);
            }}
            label={t("cron.form.expression")}
            required
            errorKey="cronExpr"
            mono
            placeholder={t("cron.form.expressionPlaceholder")}
          />
        </span>
      ) : undefined}
      {showHours() ? <ScheduleHours {...props} /> : undefined}
      {form().activeHoursEnabled ? (
        <span class="cron-sentence__row">
          <span class="cron-sentence__label" aria-hidden="true">
            {t("cron.schedule.hours")}
          </span>
          <span class="cron-tray-pair">
            <TrayInput
              {...props}
              field="activeHoursStart"
              label={t("cron.form.activeHoursStart")}
              errorKey="activeHoursStart"
              size="narrow"
              placeholder="09:00"
            />
            <span aria-hidden="true">–</span>
            <TrayInput
              {...props}
              field="activeHoursEnd"
              label={t("cron.form.activeHoursEnd")}
              errorKey="activeHoursEnd"
              size="narrow"
              placeholder="17:00"
            />
          </span>
        </span>
      ) : undefined}
      {form().scheduleKind === "cron" || form().activeHoursEnabled ? (
        <span class="cron-sentence__row">
          <span class="cron-sentence__label" aria-hidden="true">
            {t("cron.form.timezoneOptional")}
          </span>
          <TrayInput
            {...props}
            field="cronTz"
            label={t("cron.form.timezoneOptional")}
            help={t("cron.form.timezoneHelp")}
            errorKey="cronTz"
            list="cron-tz-suggestions"
            placeholder={t("cron.form.timezoneGateway")}
          />
        </span>
      ) : undefined}
      {savedHoursZone() ? (
        <span class="cron-sentence__row">
          <span class="cron-tray-note__text">
            {t("cron.form.splitTimezone", { zone: savedHoursZone() ?? "" })}
          </span>
        </span>
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
/**
 * A saved one-shot’s runtime when it no longer matches the configured time.
 */
export function ScheduleNote(props: CronProps) {
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
  const runtime = createMemo(() => {
    const job = savedOneShot();
    if (job?.schedule.kind !== "at") {
      return null;
    }
    const next = describeJobNextRun(job, true);
    // A next run at the configured time would only repeat the time field.
    return next === t("cron.form.nextRunAt", { at: formatMs(Date.parse(job.schedule.at)) })
      ? null
      : next;
  });
  return (
    <>
      {runtime() ? (
        <span class="cron-sentence__row">
          <span class="cron-tray-note__text" data-test-id="cron-schedule-note">
            {runtime()}
          </span>
        </span>
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
