import { formatByteSize } from "@openclaw/normalization-core";
import { truncateUtf16Safe } from "@openclaw/normalization-core/utf16-slice";
import type { JSX as SolidJSX } from "@solidjs/web";
import { For, Show, untrack } from "solid-js";
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
import type { SparklineSample } from "../../components/sparkline-tile.ts";
import { formatDurationHuman } from "../../lib/format-duration.ts";
import { formatRelativeTimestamp } from "../../lib/format.ts";
import {
  loadCommandLaneDiagnostics,
  type CommandLaneDiagnostics,
} from "../../lib/gateway-diagnostics.ts";
import { t } from "../../lib/reactive/i18n.ts";
import { readSystemInfo } from "../../lib/system-info.ts";
import { LitContent } from "../../lit/solid-bridge.ts";
import {
  DEBUG_OVERLAY_SECTION_HEADERS,
  type DebugOverlaySectionId,
} from "./debug-overlay-loading.ts";
import { CommandLaneRows } from "./lane-table.tsx";

export type DebugOverlayStatusSnapshot = GatewayStatusSnapshot & {
  pingMs: number;
  sampledAt: number;
  disks?: SystemInfoResult["disks"];
  uptimeMs?: number;
};
export type DebugOverlayStatusSample = GatewayStatusSample<DebugOverlayStatusSnapshot>;
type Context = { client: GatewayBrowserClient; gateway: ApplicationGateway };
export type DebugOverlaySectionDescriptor = {
  id: DebugOverlaySectionId;
  titleKey: string;
  load: (context: Context, signal: AbortSignal) => Promise<unknown>;
  render: (props: {
    value: unknown;
    history: readonly DebugOverlayStatusSample[];
  }) => SolidJSX.Element;
};
function section<T>(descriptor: {
  id: DebugOverlaySectionId;
  titleKey: string;
  load: (context: Context, signal: AbortSignal) => Promise<T>;
  render: (props: { value: T; history: readonly DebugOverlayStatusSample[] }) => SolidJSX.Element;
}): DebugOverlaySectionDescriptor {
  // Each descriptor keeps its loader paired with its renderer.
  return {
    ...descriptor,
    render: (props) =>
      descriptor.render({
        get value() {
          // SAFETY: This descriptor renders only values returned by its paired loader.
          return props.value as T;
        },
        get history() {
          return props.history;
        },
      }),
  };
}
const storageBytes = (bytes: number) =>
  formatByteSize(bytes, {
    style: "legacy-binary",
    maxUnit: "tera",
    separator: " ",
    fractionDigits: (value, unit) => (unit === "byte" ? null : value < 10 ? 1 : 0),
  });

export function DebugOverlayWidget(props: {
  status: DebugOverlayStatusSnapshot;
  history: readonly DebugOverlayStatusSample[];
}) {
  return (
    <div class="debug-overlay__widget">
      <LitContent render={() => renderGatewayCpuVital(props.status, props.history)} />
      <LitContent render={() => renderGatewayMemoryVital(props.status, props.history)} />
      <openclaw-sparkline
        class="gateway-vital gateway-vital--ping"
        data-degraded={props.status.pingMs > 250 ? "" : undefined}
        title={t("debug.overlay.pingDescription")}
        prop:label={t("debug.overlay.ping")}
        prop:samples={collectGatewayStatusSamples(props.history, (sample) => sample.pingMs)}
        prop:format={(value: number) =>
          untrack(() => t("debug.overlay.pingMs", { value: String(Math.round(value)) }))
        }
        prop:floorMax={20}
      />
    </div>
  );
}
function Status(props: {
  status: DebugOverlayStatusSnapshot;
  history: readonly DebugOverlayStatusSample[];
}) {
  return (
    <>
      <LitContent render={() => renderGatewayVitals(props.status, props.history)} />
      <Show when={props.status.disks?.length}>
        <div class="gateway-vitals debug-overlay__disks">
          <For each={props.status.disks ?? []} keyed={(disk) => disk.path}>
            {(disk) => (
              <openclaw-sparkline
                class="gateway-vital gateway-vital--disk"
                title={disk().path}
                prop:label={`${t("debug.overlay.disk")} ${disk().path}`}
                prop:sub={t("debug.overlay.totalShort", { value: storageBytes(disk().totalBytes) })}
                prop:samples={collectGatewayStatusSamples(
                  props.history,
                  (sample) =>
                    sample.disks?.find((entry) => entry.path === disk().path)?.availableBytes,
                )}
                prop:format={(value: number) =>
                  untrack(() => t("debug.overlay.freeShort", { value: storageBytes(value) }))
                }
                autorange
              />
            )}
          </For>
        </div>
      </Show>
      <Show when={typeof props.status.uptimeMs === "number"}>
        <div class="debug-overlay__vitals-footer mono">
          {t("debug.overlay.uptime")} {formatDurationHuman(props.status.uptimeMs)}
        </div>
      </Show>
    </>
  );
}
function Lanes(props: { value: CommandLaneDiagnostics }) {
  return (
    <div class="debug-overlay__table-wrap">
      <table class="data-table command-lanes-table command-lanes-table--compact">
        <thead>
          <tr>
            <For each={["lane", "active", "queued", "blocked"]}>
              {(key) => <th>{t(`debug.lanes.${key}`)}</th>}
            </For>
          </tr>
        </thead>
        <tbody>
          <CommandLaneRows lanes={props.value.lanes} dynamic={props.value.dynamic} compact />
        </tbody>
      </table>
    </div>
  );
}
function ActiveRuns(props: { value: SessionsListResult }) {
  return (
    <>
      <div class="debug-overlay__count">
        {t("debug.overlay.activeRunsCount", {
          count: String(props.value.totalCount ?? props.value.sessions.length),
        })}
      </div>
      <Show when={props.value.hasMore}>
        <div class="debug-overlay__count">
          {t("activityFeed.showing", {
            shown: String(props.value.sessions.length),
            total: String(props.value.totalCount ?? props.value.sessions.length),
          })}
        </div>
      </Show>
      <Show
        when={props.value.sessions.length > 0}
        fallback={<div class="debug-overlay__empty">{t("debug.overlay.noActiveRuns")}</div>}
      >
        <ul class="debug-overlay__list">
          <For each={props.value.sessions}>
            {(session) => (
              <li class="mono" title={session.sessionId ?? session.key}>
                {truncateUtf16Safe(session.sessionId ?? session.key, 32)}
              </li>
            )}
          </For>
        </ul>
      </Show>
    </>
  );
}
function Events(props: { gateway: ApplicationGateway }) {
  const events = () => props.gateway.eventLog.slice(0, 8);
  return (
    <Show
      when={events().length > 0}
      fallback={<div class="debug-overlay__empty">{t("debug.noEvents")}</div>}
    >
      <ul class="debug-overlay__list debug-overlay__events">
        <For each={events()}>
          {(event) => (
            <li>
              <span class="mono">{event.event}</span>
              <time>{formatRelativeTimestamp(event.ts)}</time>
            </li>
          )}
        </For>
      </ul>
    </Show>
  );
}
export const DEBUG_OVERLAY_SECTIONS: readonly DebugOverlaySectionDescriptor[] = [
  section({
    ...DEBUG_OVERLAY_SECTION_HEADERS.lanes,
    load: (context, signal) => loadCommandLaneDiagnostics(context.client, signal),
    render: (props) => <Lanes value={props.value} />,
  }),
  section({
    ...DEBUG_OVERLAY_SECTION_HEADERS.status,
    load: async (context, signal): Promise<DebugOverlayStatusSnapshot> => {
      const sample = await readSystemInfo(context.gateway, signal);
      return { ...sample.value, pingMs: sample.roundTripMs, sampledAt: sample.at };
    },
    render: (props) => <Status status={props.value} history={props.history} />,
  }),
  section({
    ...DEBUG_OVERLAY_SECTION_HEADERS["active-runs"],
    load: (context, signal) =>
      context.client.request<SessionsListResult>(
        "sessions.list",
        { activeOnly: true, archived: "all", includeGlobal: true, includeUnknown: true },
        { signal },
      ),
    render: (props) => <ActiveRuns value={props.value} />,
  }),
  section({
    ...DEBUG_OVERLAY_SECTION_HEADERS.events,
    load: async (context) => context.gateway,
    render: (props) => <Events gateway={props.value} />,
  }),
];

declare module "@solidjs/web" {
  namespace JSX {
    interface IntrinsicElements {
      "openclaw-sparkline": SolidJSX.HTMLAttributes<HTMLElementTagNameMap["openclaw-sparkline"]> & {
        "prop:label"?: string;
        "prop:sub"?: string;
        "prop:samples"?: readonly SparklineSample[];
        "prop:format"?: (value: number) => string;
        "prop:floorMax"?: number;
        autorange?: boolean;
      };
    }
  }
}
