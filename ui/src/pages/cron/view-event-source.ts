import { html, nothing } from "lit";
import { ifDefined } from "lit/directives/if-defined.js";
import { t } from "../../i18n/index.ts";
import { formatUiExternalText } from "../../lib/format-error.ts";
import { formatMs } from "../../lib/format.ts";
import { errorIdForField, renderCronSelect, renderFieldRow } from "./view-fields.ts";
import type { CronProps } from "./view-types.ts";

export function renderEventSourceFields(props: CronProps) {
  const source = props.eventSource;
  if (props.form.eventSource !== "mcp-events") {
    return html`<p class="muted">
      ${t("cron.events.readOnlySource", { source: props.form.eventSource })}
    </p>`;
  }
  if (!source?.available) {
    return html`<div class="cron-error-banner" role="status">${t("cron.events.unavailable")}</div>`;
  }
  const definition = source.events.find((event) => event.name === props.form.eventName);
  const errors = props.fieldErrors;
  const serverOptions = [...new Set([...source.servers, props.form.eventServer].filter(Boolean))];
  return html`
    ${renderCronSelect(props, "eventServer", {
      label: t("cron.events.server"),
      help: t("cron.events.serverHelp"),
      errorKey: "eventServer",
      options: [
        { value: "", label: t("cron.events.chooseServer") },
        ...serverOptions.map((value) => ({ value, label: value })),
      ],
    })}
    ${!serverOptions.length ? html`<p class="muted">${t("cron.events.noServers")}</p>` : nothing}
    ${renderCronSelect(props, "eventName", {
      label: t("cron.events.name"),
      required: true,
      help: definition?.description,
      errorKey: "eventName",
      disabled: source.loading || !props.form.eventServer,
      options: [
        { value: "", label: t("cron.events.chooseEvent") },
        ...source.events.map((event) => ({ value: event.name, label: event.name })),
        ...(props.form.eventName && !definition
          ? [{ value: props.form.eventName, label: props.form.eventName }]
          : []),
      ],
    })}
    <div class="cron-inline-controls">
      <button
        type="button"
        class="btn btn--sm"
        data-test-id="cron-events-refresh"
        ?disabled=${source.loading}
        @click=${source.onRefresh}
      >
        ${t("cron.events.refresh")}
      </button>
      ${source.loading ? html`<span role="status">${t("cron.events.loading")}</span>` : nothing}
    </div>
    ${source.error ? html`<div class="cron-error-banner" role="alert">${source.error}</div>` : nothing}
    ${!source.loading && !source.error && props.form.eventServer && !source.events.length ? html`<p class="muted">${t("cron.events.noEvents")}</p>` : nothing}
    ${renderFieldRow({
      label: t("cron.events.arguments"),
      controlId: "cron-event-arguments",
      help: t("cron.events.argumentsHelp"),
      stacked: true,
      wide: true,
      error: errors.eventArguments,
      errorId: errorIdForField("eventArguments"),
      control: html`<textarea
        id="cron-event-arguments"
        class="settings-input mono"
        rows="5"
        .value=${props.form.eventArguments}
        aria-invalid=${errors.eventArguments ? "true" : "false"}
        aria-describedby=${ifDefined(errors.eventArguments ? errorIdForField("eventArguments") : undefined)}
        @input=${(event: Event) => {
          if (event.currentTarget instanceof HTMLTextAreaElement) {
            props.onFormChange({ eventArguments: event.currentTarget.value });
          }
        }}
      ></textarea>`,
    })}
    ${
      definition
        ? html`<details class="cron-advanced">
            <summary>${t("cron.events.schema")}</summary>
            <pre class="code-block">${JSON.stringify(definition.inputSchema, null, 2)}</pre>
          </details>`
        : nothing
    }
    ${
      props.editingJob
        ? html`
            <div class="cron-schedule-summary" data-test-id="cron-event-status" role="status">
              <strong>${t("cron.events.subscription")}</strong>
              ${!props.editingJob.enabled ? t("cron.events.paused") : source.loading ? t("cron.events.loading") : !source.subscriptions.length ? t("cron.events.pending") : nothing}
              ${(props.editingJob.enabled ? source.subscriptions : []).map(
                (subscription) => html`<span>${subscription.status}</span>
                  ${subscription.lastError ? html`<span class="cron-error-banner">${formatUiExternalText(subscription.lastError)}</span>` : nothing}
                  ${subscription.truncated ? html`<span class="cron-error-banner">${t("cron.events.gap")}</span>` : nothing}
                  ${subscription.nextAttemptAt ? html`<span>${t("cron.events.retryAt", { at: formatMs(subscription.nextAttemptAt) })}</span>` : nothing} `,
              )}
            </div>
          `
        : nothing
    }
    ${source.statusError ? html`<div class="cron-error-banner" role="alert">${source.statusError}</div>` : nothing}
  `;
}
