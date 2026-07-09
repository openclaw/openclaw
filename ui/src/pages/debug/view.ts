// Control UI view renders debug screen content.
import { html, nothing } from "lit";
import type { EventLogEntry } from "../../api/event-log.ts";
import { i18n, t } from "../../i18n/index.ts";
import { formatTimeMs } from "../../lib/format.ts";
import { formatEventPayload } from "../../lib/presenter.ts";
import type {
  UiDiagnosticArea,
  UiDiagnosticDetailCode,
  UiDiagnosticId,
  UiDiagnosticRow,
  UiDiagnosticStatus,
  UiDiagnosticValue,
  UiDiagnosticValueCode,
} from "./ui-diagnostics.ts";

type DebugProps = {
  loading: boolean;
  status: Record<string, unknown> | null;
  health: Record<string, unknown> | null;
  models: unknown[];
  heartbeat: unknown;
  eventLog: readonly EventLogEntry[];
  methods: string[];
  callMethod: string;
  callParams: string;
  callResult: string | null;
  callError: string | null;
  uiDiagnostics: readonly UiDiagnosticRow[];
  uiDiagnosticsLoading: boolean;
  onCallMethodChange: (next: string) => void;
  onCallParamsChange: (next: string) => void;
  onRefresh: () => void;
  onRefreshUiDiagnostics: () => void;
  onCall: () => void;
};

function uiDiagnosticAreaLabel(area: UiDiagnosticArea): string {
  switch (area) {
    case "runtime":
      return t("debug.uiDiagnostics.areas.runtime");
    case "display":
      return t("debug.uiDiagnostics.areas.display");
    case "capabilities":
      return t("debug.uiDiagnostics.areas.capabilities");
    case "media":
      return t("debug.uiDiagnostics.areas.media");
  }
}

function uiDiagnosticStatusLabel(status: UiDiagnosticStatus): string {
  switch (status) {
    case "ok":
      return t("debug.uiDiagnostics.statuses.ok");
    case "warn":
      return t("debug.uiDiagnostics.statuses.warn");
    case "error":
      return t("debug.uiDiagnostics.statuses.error");
    case "unknown":
      return t("debug.uiDiagnostics.statuses.unknown");
  }
}

function uiDiagnosticSignalLabel(id: UiDiagnosticId): string {
  switch (id) {
    case "runtime.collection":
      return t("debug.uiDiagnostics.signals.collection");
    case "runtime.surface":
      return t("debug.uiDiagnostics.signals.surface");
    case "runtime.visibility":
      return t("debug.uiDiagnostics.signals.pageVisibility");
    case "runtime.network":
      return t("debug.uiDiagnostics.signals.network");
    case "runtime.secure-context":
      return t("debug.uiDiagnostics.signals.secureContext");
    case "runtime.locale":
      return t("debug.uiDiagnostics.signals.browserLocale");
    case "display.viewport":
      return t("debug.uiDiagnostics.signals.viewport");
    case "display.screen":
      return t("debug.uiDiagnostics.signals.screen");
    case "display.pixel-ratio":
      return t("debug.uiDiagnostics.signals.devicePixelRatio");
    case "display.theme":
      return t("debug.uiDiagnostics.signals.resolvedTheme");
    case "display.color-scheme":
      return t("debug.uiDiagnostics.signals.systemColorScheme");
    case "display.reduced-motion":
      return t("debug.uiDiagnostics.signals.reducedMotion");
    case "capabilities.websocket":
      return t("debug.uiDiagnostics.signals.webSocket");
    case "capabilities.webrtc":
      return t("debug.uiDiagnostics.signals.webRtc");
    case "capabilities.web-audio":
      return t("debug.uiDiagnostics.signals.webAudio");
    case "capabilities.clipboard":
      return t("debug.uiDiagnostics.signals.clipboardWrite");
    case "capabilities.media-capture":
      return t("debug.uiDiagnostics.signals.mediaCapture");
    case "capabilities.device-enumeration":
      return t("debug.uiDiagnostics.signals.deviceEnumeration");
    case "media.device-scan":
      return t("debug.uiDiagnostics.signals.deviceScan");
    case "media.microphone-inputs":
      return t("debug.uiDiagnostics.signals.microphoneInputs");
  }
}

function uiDiagnosticCodeLabel(code: UiDiagnosticValueCode): string {
  switch (code) {
    case "unknown":
      return t("debug.uiDiagnostics.values.codes.unknown");
    case "macos-app":
      return t("debug.uiDiagnostics.values.codes.macosApp");
    case "browser":
      return t("debug.uiDiagnostics.values.codes.browser");
    case "visible":
      return t("debug.uiDiagnostics.values.codes.visible");
    case "hidden":
      return t("debug.uiDiagnostics.values.codes.hidden");
    case "online":
      return t("debug.uiDiagnostics.values.codes.online");
    case "offline":
      return t("debug.uiDiagnostics.values.codes.offline");
    case "yes":
      return t("debug.uiDiagnostics.values.codes.yes");
    case "no":
      return t("debug.uiDiagnostics.values.codes.no");
    case "light":
      return t("debug.uiDiagnostics.values.codes.light");
    case "dark":
      return t("debug.uiDiagnostics.values.codes.dark");
    case "enabled":
      return t("debug.uiDiagnostics.values.codes.enabled");
    case "disabled":
      return t("debug.uiDiagnostics.values.codes.disabled");
    case "available":
      return t("debug.uiDiagnostics.values.codes.available");
    case "unavailable":
      return t("debug.uiDiagnostics.values.codes.unavailable");
    case "unsupported":
      return t("debug.uiDiagnostics.values.codes.unsupported");
    case "complete":
      return t("debug.uiDiagnostics.values.codes.complete");
    case "failed":
      return t("debug.uiDiagnostics.values.codes.failed");
    case "theme-dark":
      return t("debug.uiDiagnostics.values.codes.themeDark");
    case "theme-light":
      return t("debug.uiDiagnostics.values.codes.themeLight");
    case "theme-openknot":
      return t("debug.uiDiagnostics.values.codes.themeOpenknot");
    case "theme-openknot-light":
      return t("debug.uiDiagnostics.values.codes.themeOpenknotLight");
    case "theme-dash":
      return t("debug.uiDiagnostics.values.codes.themeDash");
    case "theme-dash-light":
      return t("debug.uiDiagnostics.values.codes.themeDashLight");
    case "theme-custom":
      return t("debug.uiDiagnostics.values.codes.themeCustom");
    case "theme-custom-light":
      return t("debug.uiDiagnostics.values.codes.themeCustomLight");
  }
}

function formatUiDiagnosticNumber(value: number): string {
  return new Intl.NumberFormat(i18n.getLocale(), { maximumFractionDigits: 2 }).format(value);
}

function uiDiagnosticValueLabel(value: UiDiagnosticValue): string {
  switch (value.kind) {
    case "code":
      return uiDiagnosticCodeLabel(value.code);
    case "dimensions":
      return t("debug.uiDiagnostics.values.dimensions", {
        width: formatUiDiagnosticNumber(value.width),
        height: formatUiDiagnosticNumber(value.height),
      });
    case "locale":
      return t("debug.uiDiagnostics.values.locale", { locale: value.locale });
    case "decimal":
      return t("debug.uiDiagnostics.values.decimal", {
        value: formatUiDiagnosticNumber(value.value),
      });
    case "count":
      return t("debug.uiDiagnostics.values.count", {
        count: formatUiDiagnosticNumber(value.value),
      });
  }
}

function uiDiagnosticDetailLabel(detail: UiDiagnosticDetailCode): string {
  switch (detail) {
    case "no-audio-inputs":
      return t("debug.uiDiagnostics.details.noAudioInputs");
    case "microphone-count-informational":
      return t("debug.uiDiagnostics.details.microphoneCountInformational");
    case "media-device-enumeration-failed":
      return t("debug.uiDiagnostics.details.mediaDeviceEnumerationFailed");
    case "media-device-enumeration-timeout":
      return t("debug.uiDiagnostics.details.mediaDeviceEnumerationTimeout");
    case "collection-failed":
      return t("debug.uiDiagnostics.details.collectionFailed");
  }
}

export function renderDebug(props: DebugProps) {
  const securityAudit =
    props.status && typeof props.status === "object"
      ? (props.status as { securityAudit?: { summary?: Record<string, number> } }).securityAudit
      : null;
  const securitySummary = securityAudit?.summary ?? null;
  const critical = securitySummary?.critical ?? 0;
  const warn = securitySummary?.warn ?? 0;
  const info = securitySummary?.info ?? 0;
  const securityTone = critical > 0 ? "danger" : warn > 0 ? "warn" : "success";
  const securityLabel =
    critical > 0
      ? t("debug.security.critical", { count: String(critical) })
      : warn > 0
        ? t("debug.security.warnings", { count: String(warn) })
        : t("debug.security.noCriticalIssues");

  return html`
    <section class="grid">
      <div class="card">
        <div class="row" style="justify-content: space-between;">
          <div>
            <div class="card-title">${t("debug.snapshotsTitle")}</div>
            <div class="card-sub">${t("debug.snapshotsSubtitle")}</div>
          </div>
          <button class="btn" ?disabled=${props.loading} @click=${props.onRefresh}>
            ${props.loading ? t("common.refreshing") : t("common.refresh")}
          </button>
        </div>
        <div class="stack" style="margin-top: 12px;">
          <div>
            <div class="muted">${t("debug.status")}</div>
            ${securitySummary
              ? html`<div class="callout ${securityTone}" style="margin-top: 8px;">
                  ${t("debug.security.audit")}:
                  ${securityLabel}${info > 0
                    ? ` · ${t("debug.security.info", { count: String(info) })}`
                    : ""}.
                  ${t("debug.security.runPrefix")}
                  <span class="mono">openclaw security audit --deep</span>
                  ${t("debug.security.runSuffix")}
                </div>`
              : nothing}
            <pre class="code-block">${JSON.stringify(props.status ?? {}, null, 2)}</pre>
          </div>
          <div>
            <div class="muted">${t("debug.health")}</div>
            <pre class="code-block">${JSON.stringify(props.health ?? {}, null, 2)}</pre>
          </div>
          <div>
            <div class="muted">${t("debug.lastHeartbeat")}</div>
            <pre class="code-block">${JSON.stringify(props.heartbeat ?? {}, null, 2)}</pre>
          </div>
        </div>
      </div>

      <div class="card">
        <div class="card-title">${t("debug.manualRpcTitle")}</div>
        <div class="card-sub">${t("debug.manualRpcSubtitle")}</div>
        <div class="stack" style="margin-top: 16px;">
          <label class="field">
            <span>${t("debug.method")}</span>
            <select
              .value=${props.callMethod}
              @change=${(e: Event) =>
                props.onCallMethodChange((e.target as HTMLSelectElement).value)}
            >
              ${!props.callMethod
                ? html` <option value="" disabled>${t("debug.selectMethod")}</option> `
                : nothing}
              ${props.methods.map((m) => html`<option value=${m}>${m}</option>`)}
            </select>
          </label>
          <label class="field">
            <span>${t("debug.paramsJson")}</span>
            <textarea
              .value=${props.callParams}
              @input=${(e: Event) =>
                props.onCallParamsChange((e.target as HTMLTextAreaElement).value)}
              rows="6"
            ></textarea>
          </label>
        </div>
        <div class="row" style="margin-top: 12px;">
          <button class="btn primary" @click=${props.onCall}>${t("common.call")}</button>
        </div>
        ${props.callError
          ? html`<div class="callout danger" style="margin-top: 12px;">${props.callError}</div>`
          : nothing}
        ${props.callResult
          ? html`<pre class="code-block" style="margin-top: 12px;">${props.callResult}</pre>`
          : nothing}
      </div>
    </section>

    <section class="card debug-ui-diagnostics" style="margin-top: 18px;">
      <div class="row debug-ui-diagnostics__header">
        <div>
          <div class="card-title">${t("debug.uiDiagnostics.title")}</div>
          <div class="card-sub">${t("debug.uiDiagnostics.subtitle")}</div>
        </div>
        <div class="debug-ui-diagnostics__actions">
          <span
            class="debug-ui-diagnostics__loading"
            role="status"
            aria-live="polite"
            aria-atomic="true"
            >${props.uiDiagnosticsLoading ? t("debug.uiDiagnostics.loading") : nothing}</span
          >
          <button
            type="button"
            class="btn"
            ?disabled=${props.uiDiagnosticsLoading}
            @click=${props.onRefreshUiDiagnostics}
          >
            ${props.uiDiagnosticsLoading
              ? t("common.refreshing")
              : t("debug.uiDiagnostics.refresh")}
          </button>
        </div>
      </div>
      <div
        class="data-table-wrapper debug-ui-diagnostics__frame"
        aria-busy=${props.uiDiagnosticsLoading ? "true" : "false"}
      >
        <div class="data-table-container debug-ui-diagnostics__scroller">
          <table
            class="data-table debug-ui-diagnostics__table"
            aria-label=${t("debug.uiDiagnostics.title")}
          >
            <thead>
              <tr>
                <th scope="col">${t("debug.uiDiagnostics.columns.area")}</th>
                <th scope="col">${t("debug.uiDiagnostics.columns.signal")}</th>
                <th scope="col">${t("debug.uiDiagnostics.columns.value")}</th>
                <th scope="col">${t("debug.uiDiagnostics.columns.status")}</th>
              </tr>
            </thead>
            <tbody>
              ${props.uiDiagnostics.length === 0
                ? html`
                    <tr class="debug-ui-diagnostics__empty-row">
                      <td class="data-table-empty-cell" colspan="4">
                        ${props.uiDiagnosticsLoading
                          ? t("debug.uiDiagnostics.loading")
                          : t("debug.uiDiagnostics.empty")}
                      </td>
                    </tr>
                  `
                : props.uiDiagnostics.map(
                    (row) => html`
                      <tr data-diagnostic-id=${row.id}>
                        <td>
                          <span class="debug-ui-diagnostics__area"
                            >${uiDiagnosticAreaLabel(row.area)}</span
                          >
                        </td>
                        <th class="debug-ui-diagnostics__signal" scope="row">
                          ${uiDiagnosticSignalLabel(row.id)}
                        </th>
                        <td>
                          <div class="debug-ui-diagnostics__value">
                            ${uiDiagnosticValueLabel(row.value)}
                          </div>
                          ${row.detail
                            ? html`<div class="debug-ui-diagnostics__detail">
                                ${uiDiagnosticDetailLabel(row.detail)}
                              </div>`
                            : nothing}
                        </td>
                        <td>
                          <span
                            class="debug-ui-diagnostics__status debug-ui-diagnostics__status--${row.status}"
                            data-status=${row.status}
                          >
                            <span
                              class="debug-ui-diagnostics__status-dot"
                              aria-hidden="true"
                            ></span>
                            <span>${uiDiagnosticStatusLabel(row.status)}</span>
                          </span>
                        </td>
                      </tr>
                    `,
                  )}
            </tbody>
          </table>
        </div>
      </div>
    </section>

    <section class="card" style="margin-top: 18px;">
      <div class="card-title">${t("debug.modelsTitle")}</div>
      <div class="card-sub">${t("debug.modelsSubtitle")}</div>
      <pre class="code-block" style="margin-top: 12px;">
${JSON.stringify(props.models ?? [], null, 2)}</pre
      >
    </section>

    <section class="card" style="margin-top: 18px;">
      <div class="card-title">${t("debug.eventLogTitle")}</div>
      <div class="card-sub">${t("debug.eventLogSubtitle")}</div>
      ${props.eventLog.length === 0
        ? html` <div class="muted" style="margin-top: 12px">${t("debug.noEvents")}</div> `
        : html`
            <div class="list debug-event-log" style="margin-top: 12px;">
              ${props.eventLog.map(
                (evt) => html`
                  <div class="list-item debug-event-log__item">
                    <div class="list-main">
                      <div class="list-title">${evt.event}</div>
                      <div class="list-sub">${formatTimeMs(evt.ts, undefined, "")}</div>
                    </div>
                    <div class="list-meta debug-event-log__meta">
                      <pre class="code-block debug-event-log__payload">
${formatEventPayload(evt.payload)}</pre
                      >
                    </div>
                  </div>
                `,
              )}
            </div>
          `}
    </section>
  `;
}
