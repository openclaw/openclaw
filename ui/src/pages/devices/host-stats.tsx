import type { SystemInfoResult } from "@openclaw/gateway-protocol";
import { createMemo, For, Show } from "solid-js";
import { CapacityMeter } from "../../components/solid/capacity-meter.tsx";
import { SettingsStatus } from "../../components/solid/settings-ui.tsx";
import { registerDevicesEnglish } from "../../i18n/locales/en-devices.ts";
import { formatResourceBytes, formatTimeAgo } from "../../lib/format.ts";
import { t, registerEnglishCatalog } from "../../lib/reactive/i18n.ts";
import { DeviceFact, MetaLine } from "./view-shared.tsx";

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
  /** Which resource this is. */
  label: string;
  value: string;
  title: string;
  warn?: number;
  danger?: number;
};

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
      label: t("devices.inventory.loadFact"),
      value: stats.loadAverage[0].toFixed(1),
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
      label: t("devices.inventory.memoryFact"),
      value: `${compactUsed} / ${total}`,
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
      label: t("devices.inventory.diskFact"),
      value: t("devices.inventory.diskLabel", { available }),
      title: t("devices.inventory.diskTitle", { available, total }),
    });
  }
  return resources;
}

function pressureTone(resource: Resource): "ok" | "warn" | "danger" {
  return resource.percent < (resource.warn ?? 80)
    ? "ok"
    : resource.percent < (resource.danger ?? 90)
      ? "warn"
      : "danger";
}

/** Resources stay on demand; only a live one under pressure earns a place on the closed row. */
export function HostPressure(props: { stats: HostResources | null | undefined }) {
  const pressured = createMemo(() =>
    resourceValues(props.stats).filter((resource) => pressureTone(resource) !== "ok"),
  );
  return (
    <Show when={pressured().length > 0}>
      <SettingsStatus
        kind={
          pressured().some((resource) => pressureTone(resource) === "danger") ? "danger" : "warn"
        }
        label={
          <MetaLine
            plain
            parts={pressured().map((resource) => `${resource.label} ${resource.value}`)}
          />
        }
      />
    </Show>
  );
}

export function HostStats(props: {
  stats: HostResources | null | undefined;
  lastKnownAtMs?: number;
}) {
  const resources = createMemo(() => resourceValues(props.stats));
  const lastKnown = () =>
    props.lastKnownAtMs === undefined
      ? undefined
      : t("devices.inventory.lastKnown", {
          time: formatTimeAgo(Math.max(0, Date.now() - props.lastKnownAtMs)),
        });
  return (
    <For each={resources()} keyed={(resource) => resource.name}>
      {(resource, index) => (
        <ResourceFact
          resource={resource()}
          lastKnown={lastKnown()}
          // Stale numbers say so once, under the last of them.
          note={index() === resources().length - 1 ? lastKnown() : undefined}
        />
      )}
    </For>
  );
}

function ResourceFact(props: { resource: Resource; lastKnown?: string; note?: string }) {
  const title = () =>
    props.lastKnown === undefined
      ? props.resource.title
      : `${props.resource.title} · ${props.lastKnown}`;
  return (
    <DeviceFact
      label={props.resource.label}
      class={["device-resource", `device-resource--${props.resource.name}`]}
      title={title()}
    >
      <span class="device-meter">
        <span class="device-resource__label">{props.resource.value}</span>
        <CapacityMeter
          mode="continuous"
          percent={Math.min(100, Math.max(0, props.resource.percent))}
          tone={props.lastKnown === undefined ? pressureTone(props.resource) : "stale"}
          label={title()}
        />
      </span>
      <Show when={props.note}>
        <span class="device-resource__note">{props.note}</span>
      </Show>
    </DeviceFact>
  );
}
