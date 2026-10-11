import type { SystemInfoResult } from "@openclaw/gateway-protocol";
import { createMemo, For, Show } from "solid-js";
import { CapacityMeter } from "../../components/solid/capacity-meter.tsx";
import { registerDevicesEnglish } from "../../i18n/locales/en-devices.ts";
import { formatByteSize, formatTimeAgo } from "../../lib/format.ts";
import { t, registerEnglishCatalog } from "../../lib/reactive/i18n.ts";

registerEnglishCatalog(registerDevicesEnglish);

type HostResources = Pick<
  SystemInfoResult,
  | "cpuCount"
  | "loadAverage"
  | "memoryTotalBytes"
  | "memoryFreeBytes"
  | "diskTotalBytes"
  | "diskAvailableBytes"
>;
type Resource = {
  name: "load" | "memory" | "disk";
  percent: number;
  label: string;
  title: string;
  warn?: number;
  danger?: number;
};

function formatResourceBytes(bytes: number): string {
  return formatByteSize(bytes, {
    style: "legacy-binary",
    maxUnit: "tera",
    separator: " ",
    fractionDigits: (value, unit) => (unit === "tera" || value < 10 ? 1 : 0),
  });
}

function resourceValues(stats: HostResources | null | undefined): Resource[] {
  if (!stats) {
    return [];
  }
  const resources: Resource[] = [];
  if (stats.loadAverage && stats.cpuCount > 0) {
    resources.push({
      name: "load",
      percent: (stats.loadAverage[0] / stats.cpuCount) * 100,
      warn: 70,
      danger: 100,
      label: t("devices.inventory.loadLabel", { load: stats.loadAverage[0].toFixed(1) }),
      title: t("devices.inventory.loadTitle", {
        averages: stats.loadAverage.map((value) => value.toFixed(2)).join(" / "),
        cores: String(stats.cpuCount),
      }),
    });
  }
  if (stats.memoryTotalBytes > 0 && stats.memoryFreeBytes >= 0) {
    const usedBytes = stats.memoryTotalBytes - stats.memoryFreeBytes;
    const used = formatResourceBytes(usedBytes);
    const total = formatResourceBytes(stats.memoryTotalBytes);
    const unit = total.slice(total.lastIndexOf(" "));
    const compactUsed = used.endsWith(unit) ? used.slice(0, -unit.length) : used;
    resources.push({
      name: "memory",
      percent: (usedBytes / stats.memoryTotalBytes) * 100,
      label: `${compactUsed} / ${total}`,
      title: t("devices.inventory.memoryTitle", { used, total }),
    });
  }
  if (
    stats.diskTotalBytes != null &&
    stats.diskTotalBytes > 0 &&
    stats.diskAvailableBytes != null
  ) {
    const available = formatResourceBytes(stats.diskAvailableBytes);
    const total = formatResourceBytes(stats.diskTotalBytes);
    resources.push({
      name: "disk",
      percent: (1 - stats.diskAvailableBytes / stats.diskTotalBytes) * 100,
      label: t("devices.inventory.diskLabel", { available }),
      title: t("devices.inventory.diskTitle", { available, total }),
    });
  }
  return resources;
}

export function HostStats(props: {
  stats: HostResources | null | undefined;
  lastKnownAtMs?: number;
}) {
  const resources = createMemo(() => resourceValues(props.stats));
  const age = () =>
    props.lastKnownAtMs === undefined
      ? undefined
      : formatTimeAgo(Math.max(0, Date.now() - props.lastKnownAtMs));
  return (
    <Show when={resources().length > 0}>
      <div class="device-resources">
        <For each={resources()} keyed={(resource) => resource.name}>
          {(resource) => <ResourceMeter resource={resource()} age={age()} />}
        </For>
      </div>
    </Show>
  );
}

function ResourceMeter(props: { resource: Resource; age?: string }) {
  const tone = () =>
    props.age !== undefined
      ? "stale"
      : props.resource.percent < (props.resource.warn ?? 80)
        ? "ok"
        : props.resource.percent < (props.resource.danger ?? 90)
          ? "warn"
          : "danger";
  const title = () =>
    props.age === undefined
      ? props.resource.title
      : `${props.resource.title} · ${t("devices.inventory.lastKnown", { time: props.age })}`;
  return (
    <span class={`device-resource device-resource--${props.resource.name}`} title={title()}>
      <span class="device-resource__label">
        {props.resource.label}
        {props.age === undefined ? "" : ` · ${props.age}`}
      </span>
      <CapacityMeter
        mode="continuous"
        percent={Math.min(100, Math.max(0, props.resource.percent))}
        tone={tone()}
        label={title()}
      />
    </span>
  );
}
