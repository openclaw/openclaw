import { For, Show, createMemo } from "solid-js";
import type { SystemInfoResult } from "../../../../packages/gateway-protocol/src/index.js";
import { SettingsSection, SettingsStatus } from "../../components/solid/settings-ui.tsx";
import { formatBytes } from "../../lib/agents/display.ts";
import { formatDurationHuman } from "../../lib/format-duration.ts";
import { t } from "../../lib/reactive/i18n.ts";
import { CONNECTION_SETTINGS_TARGET_IDS } from "../config/settings-targets.ts";

type SystemSectionProps = {
  systemInfo?: SystemInfoResult | null;
  systemInfoUnavailable?: boolean;
  systemInfoLoading?: boolean;
};

type SystemStat = {
  label: string;
  value: string;
  unit?: string;
  detail?: string;
  /** Used share of the resource (0..1); renders the meter bar when present. */
  usedFraction?: number;
  path?: string;
  title?: string;
};

function SystemMeter(props: { label: string; fraction: number }) {
  const clamped = () => Math.min(Math.max(props.fraction, 0), 1);
  const percent = () => Math.round(clamped() * 100);
  // Meter tones reuse the status palette: calm until 75%, warn to 92%, critical beyond.
  const tone = () => (clamped() >= 0.92 ? "critical" : clamped() >= 0.75 ? "warn" : "ok");
  return (
    <div
      class="config-host__meter"
      role="meter"
      aria-label={t("quickSettings.system.usage", { label: props.label })}
      aria-valuemin="0"
      aria-valuemax="100"
      aria-valuenow={percent()}
    >
      <div
        class={["config-host__meter-fill", `config-host__meter-fill--${tone()}`]}
        style={{ "--config-host-meter-fill": `${percent()}%` }}
      />
    </div>
  );
}

function SystemStatView(props: { stat: SystemStat }) {
  const label = () =>
    props.stat.path ? `${props.stat.label} ${props.stat.path}` : props.stat.label;
  return (
    <div class="config-host__stat" title={props.stat.title}>
      <div class="config-host__stat-label">
        {props.stat.label}
        <Show when={props.stat.path}>
          {" "}
          <span class="config-host__stat-path">{props.stat.path}</span>
        </Show>
      </div>
      <div class="config-host__stat-value">
        {props.stat.value}
        <Show when={props.stat.unit}>
          {" "}
          <span class="config-host__stat-unit">{props.stat.unit}</span>
        </Show>
      </div>
      <Show when={props.stat.usedFraction != null}>
        <SystemMeter label={label()} fraction={props.stat.usedFraction!} />
      </Show>
      <Show when={props.stat.detail}>
        <div class="config-host__stat-detail">{props.stat.detail}</div>
      </Show>
    </div>
  );
}

function Placeholder(props: { loading: boolean | undefined }) {
  return (
    <Show when={props.loading} fallback="—">
      <span class="skeleton config-host__placeholder" aria-hidden="true" />
    </Show>
  );
}

function formatUsedPercent(fraction: number) {
  return `${Math.round(Math.min(Math.max(fraction, 0), 1) * 100)}%`;
}

function resourceStat(
  kind: "memory" | "disk",
  totalBytes: number | undefined,
  freeBytes: number | undefined,
  path?: string,
): SystemStat {
  const used =
    totalBytes == null || freeBytes == null || totalBytes <= 0
      ? undefined
      : (totalBytes - freeBytes) / totalBytes;
  return {
    label: t(`quickSettings.system.${kind}`),
    value: used == null ? "—" : formatUsedPercent(used),
    unit: used == null ? undefined : t("quickSettings.system.used"),
    detail: t("quickSettings.system.freeOf", {
      free: formatBytes(freeBytes),
      total: formatBytes(totalBytes),
    }),
    usedFraction: used,
    path,
  };
}

function buildSystemStats(info: SystemInfoResult): SystemStat[] {
  const load = info.loadAverage?.[0];
  const loadTitle = info.loadAverage
    ? t("quickSettings.system.loadAverage", {
        values: info.loadAverage.map((value) => value.toFixed(1)).join(" · "),
      })
    : undefined;
  const cpuTitle = [info.cpuModel, loadTitle].filter(Boolean).join(" · ") || undefined;
  const coresLabel = t(
    info.cpuCount === 1 ? "quickSettings.system.core" : "quickSettings.system.cores",
    { count: String(info.cpuCount) },
  );
  const cpu: SystemStat =
    load == null
      ? {
          label: t("quickSettings.system.cpu"),
          value: coresLabel,
          detail: info.cpuModel,
        }
      : {
          label: t("quickSettings.system.cpu"),
          value: load.toFixed(1),
          unit: t("quickSettings.system.load"),
          detail: coresLabel,
          // 1-minute load over core count approximates saturation; >100% clamps full.
          usedFraction: info.cpuCount > 0 ? load / info.cpuCount : undefined,
          title: cpuTitle,
        };
  const stats = [cpu, resourceStat("memory", info.memoryTotalBytes, info.memoryFreeBytes)];
  for (const disk of info.disks ?? []) {
    const stat = resourceStat("disk", disk.totalBytes, disk.availableBytes, disk.path);
    if (stat.usedFraction != null) {
      stats.push(stat);
    }
  }
  return stats;
}

/** Gateway host section with the stable settings-search scroll target id. */
export function SystemSection(props: SystemSectionProps) {
  const info = () => props.systemInfo;
  const hostTitle = () =>
    info() && info()!.hostname !== info()!.machineName ? info()!.hostname : undefined;
  const address = () =>
    info()?.lanAddress
      ? `${info()!.lanAddress}${info()!.port == null ? "" : `:${info()!.port}`}`
      : undefined;
  const stats = createMemo(() => (info() ? buildSystemStats(info()!) : []));

  // Host identity and metered stats use a custom two-column grid with aligned row padding.
  return (
    <Show when={!props.systemInfoUnavailable}>
      <div
        id={CONNECTION_SETTINGS_TARGET_IDS.host}
        aria-busy={props.systemInfoLoading ? "true" : "false"}
      >
        <SettingsSection
          title={t("quickSettings.system.gatewayHost")}
          actions={
            <Show when={info()}>
              <SettingsStatus
                kind="ok"
                label={t("quickSettings.system.up", {
                  duration: formatDurationHuman(info()!.uptimeMs),
                })}
              />
            </Show>
          }
        >
          <div class="config-host">
            <div class="config-host__identity">
              <div class="config-host__name" title={hostTitle() ?? ""}>
                <Show when={info()} fallback={<Placeholder loading={props.systemInfoLoading} />}>
                  {info()?.machineName}
                </Show>
              </div>
              <div class="config-host__meta">
                <Show
                  when={info()}
                  fallback={<Placeholder loading={props.systemInfoLoading} />}
                >{`${info()?.osLabel} · ${info()?.arch}`}</Show>
              </div>
              <div class="config-host__meta">
                <Show when={info()} fallback={<Placeholder loading={props.systemInfoLoading} />}>
                  {t("quickSettings.system.runtime", {
                    version: info()?.nodeVersion ?? "",
                    pid: String(info()?.pid),
                  })}
                </Show>
              </div>
              <Show when={address()}>
                <code class="config-host__address">{address()}</code>
              </Show>
            </div>
            <div class="config-host__stats">
              <Show
                when={info()}
                fallback={
                  <For each={["cpu", "memory", "disk"]}>
                    {(kind) => (
                      <div class="config-host__stat">
                        <div class="config-host__stat-label">
                          {t(`quickSettings.system.${kind}`)}
                        </div>
                        <div class="config-host__stat-value">
                          <Placeholder loading={props.systemInfoLoading} />
                        </div>
                      </div>
                    )}
                  </For>
                }
              >
                <For each={stats()} keyed={(stat) => `${stat.label}:${stat.path ?? ""}`}>
                  {(stat) => <SystemStatView stat={stat()} />}
                </For>
              </Show>
            </div>
          </div>
        </SettingsSection>
      </div>
    </Show>
  );
}
