import { formatByteSize } from "@openclaw/normalization-core";
import { truncateUtf16Safe } from "@openclaw/normalization-core/utf16-slice";
import { html, nothing, type TemplateResult } from "lit";
import { repeat } from "lit/directives/repeat.js";
import type { SystemInfoResult } from "../../../../packages/gateway-protocol/src/index.js";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import type { SessionsListResult } from "../../api/types.ts";
import type { ApplicationGateway } from "../../app/gateway.ts";
import {
  collectGatewayStatusSamples,
  renderGatewayCpuVital,
  renderGatewayMemoryVital,
  renderGatewayVitals,
  type GatewayStatusSample,
  type GatewayStatusSnapshot,
} from "../../components/gateway-vitals.ts";
import { t } from "../../i18n/index.ts";
import { formatDurationHuman } from "../../lib/format-duration.ts";
import { formatRelativeTimestamp } from "../../lib/format.ts";
import {
  loadCommandLaneDiagnostics,
  type CommandLaneDiagnostics,
} from "../../lib/gateway-diagnostics.ts";
import { readSystemInfo } from "../../lib/system-info.ts";
import {
  DEBUG_OVERLAY_SECTION_HEADERS,
  type DebugOverlaySectionId,
} from "./debug-overlay-loading.ts";
import { renderCommandLaneRows } from "./lane-table.ts";

type DebugOverlaySectionContext = {
  client: GatewayBrowserClient;
  gateway: ApplicationGateway;
};

type TypedDebugOverlaySectionDescriptor<T> = {
  id: DebugOverlaySectionId;
  titleKey: string;
  load: (context: DebugOverlaySectionContext, signal: AbortSignal) => Promise<T>;
  render: (value: T, statusHistory: readonly DebugOverlayStatusSample[]) => TemplateResult;
};

export type DebugOverlaySectionDescriptor = TypedDebugOverlaySectionDescriptor<unknown>;

function defineDebugOverlaySection<T>(
  descriptor: TypedDebugOverlaySectionDescriptor<T>,
): DebugOverlaySectionDescriptor {
  return {
    ...descriptor,
    render: (value, statusHistory) => {
      // SAFETY: This closure keeps each descriptor's load result paired with its own renderer.
      return descriptor.render(value as T, statusHistory);
    },
  };
}

export type DebugOverlayStatusSnapshot = GatewayStatusSnapshot & {
  pingMs: number;
  sampledAt: number;
  disks?: SystemInfoResult["disks"];
  uptimeMs?: number;
};

export type DebugOverlayStatusSample = GatewayStatusSample<DebugOverlayStatusSnapshot>;

const PING_DEGRADED_THRESHOLD_MS = 250;

function formatPingMs(value: number): string {
  return t("debug.overlay.pingMs", { value: String(Math.round(value)) });
}

export function renderDebugOverlayWidget(
  status: DebugOverlayStatusSnapshot,
  history: readonly DebugOverlayStatusSample[],
): TemplateResult {
  return html`<div class="debug-overlay__widget">
    ${renderGatewayCpuVital(status, history)}
    <openclaw-sparkline
      class="gateway-vital gateway-vital--ping"
      data-degraded=${status.pingMs > PING_DEGRADED_THRESHOLD_MS ? "" : nothing}
      title=${t("debug.overlay.pingDescription")}
      .label=${t("debug.overlay.ping")}
      .samples=${collectGatewayStatusSamples(history, (sample) => sample.pingMs)}
      .format=${formatPingMs}
      .floorMax=${20}
    ></openclaw-sparkline>
    ${renderGatewayMemoryVital(status, history)}
  </div>`;
}

function renderLanes(diagnostics: CommandLaneDiagnostics): TemplateResult {
  return html`
    <div class="debug-overlay__table-wrap">
      <table class="data-table command-lanes-table command-lanes-table--compact">
        <thead>
          <tr>
            <th>${t("debug.lanes.lane")}</th>
            <th>${t("debug.lanes.active")}</th>
            <th>${t("debug.lanes.queued")}</th>
            <th>${t("debug.lanes.blocked")}</th>
          </tr>
        </thead>
        <tbody>
          ${renderCommandLaneRows(diagnostics, { compact: true })}
        </tbody>
      </table>
    </div>
  `;
}

function formatFreeBytes(bytes: number): string {
  return t("debug.overlay.freeShort", { value: formatStorageBytes(bytes) });
}

function formatStorageBytes(bytes: number): string {
  return formatByteSize(bytes, {
    style: "legacy-binary",
    maxUnit: "tera",
    separator: " ",
    fractionDigits: (value, unit) => (unit === "byte" ? null : value < 10 ? 1 : 0),
  });
}

function renderStatus(
  status: DebugOverlayStatusSnapshot,
  history: readonly DebugOverlayStatusSample[],
): TemplateResult {
  return html`
    ${renderGatewayVitals(status, history)}
    ${
      status.disks?.length
        ? html`<div class="gateway-vitals debug-overlay__disks">
            ${repeat(
              status.disks ?? [],
              (disk) => disk.path,
              (disk) => html`<openclaw-sparkline
                class="gateway-vital gateway-vital--disk"
                title=${disk.path}
                .label=${`${t("debug.overlay.disk")} ${disk.path}`}
                .sub=${t("debug.overlay.totalShort", { value: formatStorageBytes(disk.totalBytes) })}
                .samples=${collectGatewayStatusSamples(
                  history,
                  (sample) =>
                    sample.disks?.find((entry) => entry.path === disk.path)?.availableBytes,
                )}
                .format=${formatFreeBytes}
                autorange
              ></openclaw-sparkline>`,
            )}
          </div>`
        : nothing
    }
    ${
      typeof status.uptimeMs === "number"
        ? html`<div class="debug-overlay__vitals-footer mono">
            ${t("debug.overlay.uptime")} ${formatDurationHuman(status.uptimeMs)}
          </div>`
        : nothing
    }
  `;
}

function renderActiveRuns({ sessions, totalCount, hasMore }: SessionsListResult): TemplateResult {
  return html`
    <div class="debug-overlay__count">
      ${t("debug.overlay.activeRunsCount", { count: String(totalCount ?? sessions.length) })}
    </div>
    ${hasMore ? html`<div class="debug-overlay__count">${t("activityFeed.showing", { shown: String(sessions.length), total: String(totalCount ?? sessions.length) })}</div>` : nothing}
    ${
      sessions.length > 0
        ? html`<ul class="debug-overlay__list">
            ${sessions.map((session) => {
              const id = session.sessionId ?? session.key;
              return html`<li class="mono" title=${id}>${truncateUtf16Safe(id, 32)}</li>`;
            })}
          </ul>`
        : html`<div class="debug-overlay__empty">${t("debug.overlay.noActiveRuns")}</div>`
    }
  `;
}

function renderEvents(gateway: ApplicationGateway): TemplateResult {
  // The store prepends: eventLog is newest-first, so the head is the live tail.
  const events = gateway.eventLog.slice(0, 8);
  return events.length > 0
    ? html`<ul class="debug-overlay__list debug-overlay__events">
        ${events.map(
          (event) => html`<li>
            <span class="mono">${event.event}</span>
            <time>${formatRelativeTimestamp(event.ts)}</time>
          </li>`,
        )}
      </ul>`
    : html`<div class="debug-overlay__empty">${t("debug.noEvents")}</div>`;
}

export const DEBUG_OVERLAY_SECTIONS: readonly DebugOverlaySectionDescriptor[] = [
  defineDebugOverlaySection({
    ...DEBUG_OVERLAY_SECTION_HEADERS.lanes,
    load: (context, signal) => loadCommandLaneDiagnostics(context.client, signal),
    render: renderLanes,
  }),
  defineDebugOverlaySection({
    ...DEBUG_OVERLAY_SECTION_HEADERS.status,
    load: async (context, signal): Promise<DebugOverlayStatusSnapshot> => {
      const sample = await readSystemInfo(context.gateway, signal);
      return { ...sample.value, pingMs: sample.roundTripMs, sampledAt: sample.at };
    },
    render: renderStatus,
  }),
  defineDebugOverlaySection({
    ...DEBUG_OVERLAY_SECTION_HEADERS["active-runs"],
    load: (context, signal) =>
      context.client.request<SessionsListResult>(
        "sessions.list",
        { activeOnly: true, archived: "all", includeGlobal: true, includeUnknown: true },
        { signal },
      ),
    render: renderActiveRuns,
  }),
  defineDebugOverlaySection({
    ...DEBUG_OVERLAY_SECTION_HEADERS.events,
    load: async (context) => context.gateway,
    render: renderEvents,
  }),
];
