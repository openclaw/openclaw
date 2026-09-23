import { html, nothing, type TemplateResult } from "lit";
import type { SystemInfoResult } from "../../../packages/gateway-protocol/src/index.js";
import "./tooltip.ts";
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
    cpuBreakdown?: NonNullable<SystemInfoResult["eventLoop"]>["cpuBreakdown"];
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
  read: (status: T) => number | Omit<SparklineSample, "at"> | undefined,
): SparklineSample[] {
  const samples: SparklineSample[] = [];
  for (const entry of history) {
    const reading = read(entry.status);
    const sample = typeof reading === "number" ? { value: reading } : reading;
    if (sample && Number.isFinite(sample.value)) {
      samples.push({ ...sample, at: entry.at });
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
  const samples = collectGatewayStatusSamples(history, (sample) => {
    const value = sample.eventLoop?.cpuCoreRatio;
    if (value === undefined) {
      return undefined;
    }
    const cpu = sample.eventLoop?.cpuBreakdown;
    const parts = [cpu?.mainThreadCoreRatio, cpu?.workerCoreRatio, cpu?.otherThreadsCoreRatio];
    return {
      value,
      secondary: t("debug.overlay.hostShort", { value: formatCpuReading(cpu?.hostUtilization) }),
      // Missing attribution is not zero work. Keep the total outline but leave a gap in the stack.
      stack: parts.every((part): part is number => typeof part === "number") ? parts : undefined,
    };
  });
  const cpu = eventLoop?.cpuBreakdown;
  return html`
    <openclaw-tooltip class="gateway-cpu-tooltip" placement="top-start" open-on-click auto-size>
      <button
        type="button"
        class="gateway-cpu-trigger"
        aria-label=${t("debug.overlay.cpuBreakdown")}
      >
        <openclaw-sparkline
          class="gateway-vital gateway-vital--cpu"
          data-degraded=${cpuDegraded ? "" : nothing}
          .label=${t("debug.overlay.cpu")}
          .sub=${t("debug.overlay.gatewayCpuScope")}
          .samples=${samples}
          .format=${formatPercent}
          .floorMax=${1}
          .stackColors=${["var(--cpu-main)", "var(--cpu-workers)", "var(--cpu-other)"]}
        ></openclaw-sparkline>
      </button>
      <div slot="content" class="gateway-cpu-detail">
        <strong>${t("debug.overlay.cpuBreakdownCurrent")}</strong>
        <dl>
          <div class="gateway-cpu-detail__total">
            <dt>${t("debug.overlay.gatewayCpuProcess")}</dt>
            <dd>${formatCpuReading(eventLoop?.cpuCoreRatio)}</dd>
          </div>
          ${renderCpuDetailRow(t("debug.overlay.mainThreadCpu"), cpu?.mainThreadCoreRatio, "main")}
          ${renderCpuDetailRow(t("debug.overlay.workerCpu"), cpu?.workerCoreRatio, "workers")}
          ${renderCpuDetailRow(t("debug.overlay.otherThreadCpu"), cpu?.otherThreadsCoreRatio, "other")}
          <div class="gateway-cpu-detail__host">
            <dt>
              ${cpu?.hostCpuCount == null ? t("debug.overlay.hostCpu") : t("debug.overlay.hostCpuCount", { count: String(cpu.hostCpuCount) })}
            </dt>
            <dd>${formatCpuReading(cpu?.hostUtilization)}</dd>
          </div>
          <div>
            <dt>${t("debug.overlay.loopUtilization")}</dt>
            <dd>${formatCpuReading(eventLoop?.utilization)}</dd>
          </div>
        </dl>
      </div>
    </openclaw-tooltip>
  `;
}

function formatCpuReading(value: number | undefined): string {
  return typeof value === "number" ? formatPercent(value) : "—";
}

function renderCpuDetailRow(label: string, value: number | undefined, kind: string) {
  return html`<div class="gateway-cpu-detail__thread">
    <dt>
      <span class="gateway-cpu-key gateway-cpu-key--${kind}" aria-hidden="true"></span>${label}
    </dt>
    <dd>${kind === "other" && typeof value === "number" ? "≈" : ""}${formatCpuReading(value)}</dd>
  </div>`;
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
