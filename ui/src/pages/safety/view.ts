// Control UI view renders AI safety observability page content.
import { html, nothing } from "lit";
import type { SafetyEventRecord } from "../../../../src/infra/safety-event-store.js";
import { formatTimeMs } from "../../lib/format.ts";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type SafetyKpi = {
  total: number;
  critical: number;
  high: number;
  medium: number;
  low: number;
  info: number;
};

export type SafetyViewProps = {
  events: SafetyEventRecord[];
  kpi: SafetyKpi;
  loading: boolean;
  error: string | null;
  filterSeverity: string;
  filterType: string;
  onSeverityChange: (value: string) => void;
  onTypeChange: (value: string) => void;
  onRefresh: () => void;
};

// ---------------------------------------------------------------------------
// KPI strip
// ---------------------------------------------------------------------------

function kpiCell(label: string, value: number, accent?: string) {
  return html`
    <div class="safety-kpi-cell" style=${accent ? `border-top: 3px solid ${accent}` : ""}>
      <span class="safety-kpi-value">${value}</span>
      <span class="safety-kpi-label">${label}</span>
    </div>
  `;
}

export function renderKpiStrip(kpi: SafetyKpi) {
  return html`
    <div class="safety-kpi-strip">
      ${kpiCell("Total", kpi.total)}
      ${kpiCell("Critical", kpi.critical, "#d94f4f")}
      ${kpiCell("High", kpi.high, "#e07a2a")}
      ${kpiCell("Medium", kpi.medium, "#d4a017")}
      ${kpiCell("Low", kpi.low, "#4a9edd")}
      ${kpiCell("Info", kpi.info, "#888")}
    </div>
  `;
}

// ---------------------------------------------------------------------------
// Event table
// ---------------------------------------------------------------------------

function severityChip(severity: string) {
  const colors: Record<string, string> = {
    critical: "#d94f4f",
    high: "#e07a2a",
    medium: "#d4a017",
    low: "#4a9edd",
    info: "#888",
  };
  const bg = colors[severity] ?? "#888";
  return html`<span class="safety-severity-chip" style="background:${bg}">${severity}</span>`;
}

function formatTs(ms: number): string {
  return formatTimeMs(ms, { hour: "2-digit", minute: "2-digit", second: "2-digit" }, "");
}

export function renderEventTable(events: SafetyEventRecord[]) {
  if (events.length === 0) {
    return html`<p class="safety-empty">No AI safety events recorded yet.</p>`;
  }
  return html`
    <table class="safety-event-table">
      <thead>
        <tr>
          <th>Time</th>
          <th>Severity</th>
          <th>Type</th>
          <th>Session</th>
          <th>Message</th>
        </tr>
      </thead>
      <tbody>
        ${events.map(
          (e) => html`
            <tr>
              <td class="safety-ts">${formatTs(e.recordedAt)}</td>
              <td>${severityChip(e.severity)}</td>
              <td class="safety-type" title=${e.type}>${e.type}</td>
              <td class="safety-session">${e.sessionId ?? nothing}</td>
              <td class="safety-message" title=${e.message}>${e.message}</td>
            </tr>
          `,
        )}
      </tbody>
    </table>
  `;
}

// ---------------------------------------------------------------------------
// Filters
// ---------------------------------------------------------------------------

function renderFilters(props: SafetyViewProps) {
  return html`
    <div class="safety-filters">
      <label>
        Severity
        <select
          .value=${props.filterSeverity}
          @change=${(e: Event) =>
            props.onSeverityChange((e.target as HTMLSelectElement).value)}
        >
          <option value="">All</option>
          <option value="critical">Critical</option>
          <option value="high">High</option>
          <option value="medium">Medium</option>
          <option value="low">Low</option>
          <option value="info">Info</option>
        </select>
      </label>
      <label>
        Type prefix
        <input
          type="text"
          placeholder="ai_safety.refusal"
          .value=${props.filterType}
          @input=${(e: Event) =>
            props.onTypeChange((e.target as HTMLInputElement).value)}
        />
      </label>
      <button class="safety-refresh-btn" @click=${props.onRefresh}>Refresh</button>
    </div>
  `;
}

// ---------------------------------------------------------------------------
// Root render
// ---------------------------------------------------------------------------

export function renderSafetyPage(props: SafetyViewProps) {
  return html`
    <div class="safety-page">
      ${renderKpiStrip(props.kpi)}
      ${renderFilters(props)}
      ${props.loading
        ? html`<p class="safety-loading">Loading…</p>`
        : props.error
          ? html`<p class="safety-error">${props.error}</p>`
          : renderEventTable(props.events)}
    </div>
  `;
}
