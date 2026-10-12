import { createMemo } from "solid-js";
import { registerDebugEnglish } from "../../i18n/locales/en-debug.ts";
import { formatDurationCompact } from "../../lib/format-duration.ts";
import { registerEnglishCatalog, t } from "../../lib/reactive/i18n.ts";
import {
  collectGatewayStatusSamples,
  type GatewayStatusSample,
  type GatewayStatusSnapshot,
} from "../gateway-vitals.ts";

registerEnglishCatalog(registerDebugEnglish);

type GatewayVitalsProps = {
  status: GatewayStatusSnapshot;
  history: readonly GatewayStatusSample[];
};

function formatPercent(value: number): string {
  return `${Math.round(value * 100)}%`;
}

function formatMemory(bytes: number): string {
  return t("debug.overlay.memoryMb", { value: String(Math.round(bytes / 1_048_576)) });
}

function formatDelay(value: number): string {
  return formatDurationCompact(value) ?? t("common.na");
}

function formatCpuReading(value: number | undefined): string {
  return typeof value === "number" ? formatPercent(value) : "—";
}

function CpuDetailRow(props: { label: string; value: number | undefined; kind: string }) {
  return (
    <div class="gateway-cpu-detail__thread">
      <dt>
        <span class={`gateway-cpu-key gateway-cpu-key--${props.kind}`} aria-hidden="true" />
        {props.label}
      </dt>
      <dd>
        {props.kind === "other" && typeof props.value === "number" ? "≈" : ""}
        {formatCpuReading(props.value)}
      </dd>
    </div>
  );
}

function GatewayCpuVital(props: GatewayVitalsProps) {
  const eventLoop = () => props.status.eventLoop;
  const cpu = () => eventLoop()?.cpuBreakdown;
  const degraded = () =>
    eventLoop()?.reasons?.some((reason) => reason === "cpu" || reason === "event_loop_utilization");
  const samples = createMemo(() =>
    collectGatewayStatusSamples(props.history, (sample) => {
      const value = sample.eventLoop?.cpuCoreRatio;
      if (value === undefined) {
        return undefined;
      }
      const breakdown = sample.eventLoop?.cpuBreakdown;
      const parts = [
        breakdown?.mainThreadCoreRatio,
        breakdown?.workerCoreRatio,
        breakdown?.otherThreadsCoreRatio,
      ];
      return {
        value,
        secondary: t("debug.overlay.hostShort", {
          value: formatCpuReading(breakdown?.hostUtilization),
        }),
        // Missing attribution is not zero work. Keep the total outline but leave a gap in the stack.
        stack: parts.every((part): part is number => typeof part === "number") ? parts : undefined,
      };
    }),
  );
  return (
    <openclaw-tooltip class="gateway-cpu-tooltip" placement="top-start" open-on-click auto-size>
      <button
        type="button"
        class="gateway-cpu-trigger"
        aria-label={t("debug.overlay.cpuBreakdown")}
      >
        <openclaw-sparkline
          class="gateway-vital gateway-vital--cpu"
          data-degraded={degraded() ? "" : undefined}
          prop:label={t("debug.overlay.cpu")}
          prop:sub={t("debug.overlay.gatewayCpuScope")}
          prop:samples={samples()}
          prop:format={formatPercent}
          prop:floorMax={1}
          prop:stackColors={["var(--cpu-main)", "var(--cpu-workers)", "var(--cpu-other)"]}
        />
      </button>
      <div slot="content" class="gateway-cpu-detail">
        <strong>{t("debug.overlay.cpuBreakdownCurrent")}</strong>
        <dl>
          <div class="gateway-cpu-detail__total">
            <dt>{t("debug.overlay.gatewayCpuProcess")}</dt>
            <dd>{formatCpuReading(eventLoop()?.cpuCoreRatio)}</dd>
          </div>
          <CpuDetailRow
            label={t("debug.overlay.mainThreadCpu")}
            value={cpu()?.mainThreadCoreRatio}
            kind="main"
          />
          <CpuDetailRow
            label={t("debug.overlay.workerCpu")}
            value={cpu()?.workerCoreRatio}
            kind="workers"
          />
          <CpuDetailRow
            label={t("debug.overlay.otherThreadCpu")}
            value={cpu()?.otherThreadsCoreRatio}
            kind="other"
          />
          <div class="gateway-cpu-detail__host">
            <dt>
              {cpu()?.hostCpuCount == null
                ? t("debug.overlay.hostCpu")
                : t("debug.overlay.hostCpuCount", { count: String(cpu()?.hostCpuCount) })}
            </dt>
            <dd>{formatCpuReading(cpu()?.hostUtilization)}</dd>
          </div>
          <div>
            <dt>{t("debug.overlay.loopUtilization")}</dt>
            <dd>{formatCpuReading(eventLoop()?.utilization)}</dd>
          </div>
        </dl>
      </div>
    </openclaw-tooltip>
  );
}

/** Solid rendering companion while the other vitals consumers still render with Lit. */
export function GatewayVitals(props: GatewayVitalsProps) {
  const memorySamples = createMemo(() =>
    collectGatewayStatusSamples(props.history, (sample) => sample.processMemory?.rssBytes),
  );
  const delaySamples = createMemo(() =>
    collectGatewayStatusSamples(props.history, (sample) => sample.eventLoop?.delayP99Ms),
  );
  return (
    <div class="gateway-vitals">
      <GatewayCpuVital status={props.status} history={props.history} />
      <openclaw-sparkline
        class="gateway-vital gateway-vital--memory"
        prop:label={t("debug.overlay.memory")}
        prop:sub={
          typeof props.status.processMemory?.heapUsedBytes === "number"
            ? t("debug.overlay.heapShort", {
                value: formatMemory(props.status.processMemory.heapUsedBytes),
              })
            : ""
        }
        prop:samples={memorySamples()}
        prop:format={formatMemory}
        autorange
      />
      <openclaw-sparkline
        class="gateway-vital gateway-vital--delay"
        data-degraded={
          props.status.eventLoop?.reasons?.includes("event_loop_delay") ? "" : undefined
        }
        prop:label={t("debug.overlay.delayP99")}
        prop:sub={
          typeof props.status.eventLoop?.delayMaxMs === "number"
            ? t("debug.overlay.maxShort", { value: formatDelay(props.status.eventLoop.delayMaxMs) })
            : ""
        }
        prop:samples={delaySamples()}
        prop:format={formatDelay}
        prop:floorMax={20}
      />
    </div>
  );
}
