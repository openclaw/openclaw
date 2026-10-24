import { createMemo, For } from "solid-js";
import { formatUiExternalText } from "../../lib/format-error.ts";
import { formatMs } from "../../lib/format.ts";
import { t } from "../../lib/reactive/i18n.ts";
import { errorIdForField, CronSelect, FieldRow } from "./view-fields.tsx";
import type { CronProps } from "./view-types.ts";

export function EventSourceFields(props: CronProps) {
  const definition = createMemo(() =>
    props.eventSource?.events.find((event) => event.name === props.form.eventName),
  );
  const serverOptions = createMemo(() => [
    ...new Set([...(props.eventSource?.servers ?? []), props.form.eventServer].filter(Boolean)),
  ]);
  return (
    <>
      {props.form.eventSource !== "mcp-events" ? (
        <p class="muted">{t("cron.events.readOnlySource", { source: props.form.eventSource })}</p>
      ) : !props.eventSource?.available ? (
        <div class="cron-error-banner" role="status">
          {t("cron.events.unavailable")}
        </div>
      ) : (
        <>
          <CronSelect
            {...props}
            field="eventServer"
            label={t("cron.events.server")}
            help={t("cron.events.serverHelp")}
            errorKey="eventServer"
            options={[
              { value: "", label: t("cron.events.chooseServer") },
              ...serverOptions().map((value) => ({ value, label: value })),
            ]}
          />
          {!serverOptions().length ? <p class="muted">{t("cron.events.noServers")}</p> : undefined}
          <CronSelect
            {...props}
            field="eventName"
            label={t("cron.events.name")}
            required
            help={definition()?.description}
            errorKey="eventName"
            disabled={props.eventSource?.loading || !props.form.eventServer}
            options={[
              { value: "", label: t("cron.events.chooseEvent") },
              ...(props.eventSource?.events ?? []).map((event) => ({
                value: event.name,
                label: event.name,
              })),
              ...(props.form.eventName && !definition()
                ? [{ value: props.form.eventName, label: props.form.eventName }]
                : []),
            ]}
          />
          <div class="cron-inline-controls">
            <button
              type="button"
              class="btn btn--sm"
              data-test-id="cron-events-refresh"
              disabled={props.eventSource?.loading}
              onClick={() => props.eventSource?.onRefresh()}
            >
              {t("cron.events.refresh")}
            </button>
            {props.eventSource?.loading ? (
              <span role="status">{t("cron.events.loading")}</span>
            ) : undefined}
          </div>
          {props.eventSource?.error ? (
            <div class="cron-error-banner" role="alert">
              {props.eventSource.error}
            </div>
          ) : undefined}
          {!props.eventSource?.loading &&
          !props.eventSource?.error &&
          props.form.eventServer &&
          !props.eventSource?.events.length ? (
            <p class="muted">{t("cron.events.noEvents")}</p>
          ) : undefined}
          <FieldRow
            label={t("cron.events.arguments")}
            controlId="cron-event-arguments"
            help={t("cron.events.argumentsHelp")}
            stacked
            wide
            error={props.fieldErrors.eventArguments}
            errorId={errorIdForField("eventArguments")}
            control={
              <textarea
                id="cron-event-arguments"
                class="settings-input mono"
                rows="5"
                value={props.form.eventArguments}
                aria-invalid={props.fieldErrors.eventArguments ? "true" : "false"}
                aria-describedby={
                  props.fieldErrors.eventArguments ? errorIdForField("eventArguments") : undefined
                }
                onInput={(event) =>
                  props.onFormChange({ eventArguments: event.currentTarget.value })
                }
              />
            }
          />
          {definition() ? (
            <details class="cron-advanced">
              <summary>{t("cron.events.schema")}</summary>
              <pre class="code-block">{JSON.stringify(definition()?.inputSchema, null, 2)}</pre>
            </details>
          ) : undefined}
          {props.editingJob ? (
            <div class="cron-schedule-summary" data-test-id="cron-event-status" role="status">
              <strong>{t("cron.events.subscription")}</strong>
              {!props.editingJob.enabled
                ? t("cron.events.paused")
                : props.eventSource?.loading
                  ? t("cron.events.loading")
                  : !props.eventSource?.subscriptions.length
                    ? t("cron.events.pending")
                    : undefined}
              <For each={props.editingJob.enabled ? (props.eventSource?.subscriptions ?? []) : []}>
                {(subscription) => (
                  <>
                    <span>{subscription.status}</span>
                    {subscription.lastError ? (
                      <span class="cron-error-banner">
                        {formatUiExternalText(subscription.lastError)}
                      </span>
                    ) : undefined}
                    {subscription.truncated ? (
                      <span class="cron-error-banner">{t("cron.events.gap")}</span>
                    ) : undefined}
                    {subscription.nextAttemptAt ? (
                      <span>
                        {t("cron.events.retryAt", { at: formatMs(subscription.nextAttemptAt) })}
                      </span>
                    ) : undefined}
                  </>
                )}
              </For>
            </div>
          ) : undefined}
          {props.eventSource?.statusError ? (
            <div class="cron-error-banner" role="alert">
              {props.eventSource.statusError}
            </div>
          ) : undefined}
        </>
      )}
    </>
  );
}
