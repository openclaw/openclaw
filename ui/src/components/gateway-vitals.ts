import { html, nothing, type TemplateResult } from "lit";
import { t } from "../i18n/index.ts";
import { registerDebugEnglish } from "../i18n/locales/en-debug.ts";
import { formatDurationCompact } from "../lib/format-duration.ts";
import "./sparkline-tile.ts";
import type { SparklineSample } from "./sparkline-tile.ts";

registerDebugEnglish();

export type GatewayStatusSnapshot = {
  eventLoop?: {
    utilization?: number;
    cpuCoreRatio?: number;
    delayP99Ms?: number;
    delayMaxMs?: number;
    reasons?: string[];
  };
  processMemory?: {
    rssBytes: number;
    heapUsedBytes: number;
    heapTotalBytes: number;
  };
};

export type GatewayStatusSample<T extends GatewayStatusSnapshot = GatewayStatusSnapshot> = {
  at: number;
  status: T;
};

export function collectGatewayStatusSamples<T extends GatewayStatusSnapshot>(
  history: readonly GatewayStatusSample<T>[],
  read: (status: T) => number | undefined,
): SparklineSample[] {
  const samples: SparklineSample[] = [];
  for (const entry of history) {
    const value = read(entry.status);
    if (typeof value === "number" && Number.isFinite(value)) {
      samples.push({ value, at: entry.at });
    } else {
      samples.length = 0;
    }
  }
  return samples;
}

function formatPercent(value: number): string {
  return `${Math.round(value * 100)}%`;
}

function formatGatewayMemory(bytes: number): string {
  return t("debug.overlay.memoryMb", { value: String(Math.round(bytes / 1_048_576)) });
}

function formatDelayMs(value: number): string {
  return formatDurationCompact(value) ?? t("common.na");
}

export function renderGatewayCpuVital(
  status: GatewayStatusSnapshot,
  history: readonly GatewayStatusSample[],
): TemplateResult {
  const eventLoop = status.eventLoop;
  const reasons = eventLoop?.reasons ?? [];
  const cpuDegraded = reasons.includes("cpu") || reasons.includes("event_loop_utilization");
  const loopSub =
    typeof eventLoop?.utilization === "number"
      ? t("debug.overlay.loopShort", { value: formatPercent(eventLoop.utilization) })
      : "";
  return html`<openclaw-sparkline
    class="gateway-vital gateway-vital--cpu"
    data-degraded=${cpuDegraded ? "" : nothing}
    .label=${t("debug.overlay.cpu")}
    .sub=${loopSub}
    .samples=${collectGatewayStatusSamples(history, (sample) => sample.eventLoop?.cpuCoreRatio)}
    .format=${formatPercent}
    .floorMax=${1}
  ></openclaw-sparkline>`;
}

export function renderGatewayMemoryVital(
  status: GatewayStatusSnapshot,
  history: readonly GatewayStatusSample[],
): TemplateResult {
  const heapSub =
    typeof status.processMemory?.heapUsedBytes === "number"
      ? t("debug.overlay.heapShort", {
          value: formatGatewayMemory(status.processMemory.heapUsedBytes),
        })
      : "";
  return html`<openclaw-sparkline
    class="gateway-vital gateway-vital--memory"
    .label=${t("debug.overlay.memory")}
    .sub=${heapSub}
    .samples=${collectGatewayStatusSamples(history, (sample) => sample.processMemory?.rssBytes)}
    .format=${formatGatewayMemory}
    autorange
  ></openclaw-sparkline>`;
}

export function renderGatewayVitals(
  status: GatewayStatusSnapshot,
  history: readonly GatewayStatusSample[],
): TemplateResult {
  const eventLoop = status.eventLoop;
  const delayDegraded = eventLoop?.reasons?.includes("event_loop_delay");
  const maxSub =
    typeof eventLoop?.delayMaxMs === "number"
      ? t("debug.overlay.maxShort", { value: formatDelayMs(eventLoop.delayMaxMs) })
      : "";
  return html`
    <div class="gateway-vitals">
      ${renderGatewayCpuVital(status, history)} ${renderGatewayMemoryVital(status, history)}
      <openclaw-sparkline
        class="gateway-vital gateway-vital--delay"
        data-degraded=${delayDegraded ? "" : nothing}
        .label=${t("debug.overlay.delayP99")}
        .sub=${maxSub}
        .samples=${collectGatewayStatusSamples(history, (sample) => sample.eventLoop?.delayP99Ms)}
        .format=${formatDelayMs}
        .floorMax=${20}
      ></openclaw-sparkline>
    </div>
  `;
}
