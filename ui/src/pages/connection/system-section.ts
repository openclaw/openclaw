import { html, nothing, type TemplateResult } from "lit";
import type { SystemInfoResult } from "../../../../packages/gateway-protocol/src/index.js";
import {
  renderSettingsSection,
  renderSettingsStatus,
  type SettingsSectionProps,
} from "../../components/settings-ui.ts";
import { t } from "../../i18n/index.ts";
import { formatBytes } from "../../lib/agents/display.ts";
import { formatDurationHuman } from "../../lib/format-duration.ts";
import { CONNECTION_SETTINGS_TARGET_IDS } from "../config/settings-targets.ts";

type SystemSectionProps = {
  systemInfo?: SystemInfoResult | null;
  systemInfoUnavailable?: boolean;
  systemInfoLoading?: boolean;
};

type SystemStat = {
  label: string;
  value: string | TemplateResult;
  unit?: string;
  detail?: string;
  /** Used share of the resource (0..1); renders the meter bar when present. */
  usedFraction?: number;
  path?: string;
  title?: string;
};

function renderSystemMeter(label: string, fraction: number) {
  const clamped = Math.min(Math.max(fraction, 0), 1);
  const percent = Math.round(clamped * 100);
  // Meter tones reuse the status palette: calm until 75%, warn to 92%, critical beyond.
  const tone = clamped >= 0.92 ? "critical" : clamped >= 0.75 ? "warn" : "ok";
  return html`
    <div
      class="config-host__meter"
      role="meter"
      aria-label=${t("quickSettings.system.usage", { label })}
      aria-valuemin="0"
      aria-valuemax="100"
      aria-valuenow=${percent}
    >
      <div
        class="config-host__meter-fill config-host__meter-fill--${tone}"
        style="--config-host-meter-fill: ${percent}%"
      ></div>
    </div>
  `;
}

function renderSystemStat(stat: SystemStat) {
  const label = stat.path ? `${stat.label} ${stat.path}` : stat.label;
  return html`
    <div class="config-host__stat" title=${stat.title ?? nothing}>
      <div class="config-host__stat-label">
        ${stat.label}${
          stat.path ? html` <span class="config-host__stat-path">${stat.path}</span>` : nothing
        }
      </div>
      <div class="config-host__stat-value">
        ${stat.value}${
          stat.unit ? html` <span class="config-host__stat-unit">${stat.unit}</span>` : nothing
        }
      </div>
      ${stat.usedFraction == null ? nothing : renderSystemMeter(label, stat.usedFraction)}
      ${stat.detail ? html`<div class="config-host__stat-detail">${stat.detail}</div>` : nothing}
    </div>
  `;
}

function usedFraction(totalBytes: number | undefined, freeBytes: number | undefined) {
  if (totalBytes == null || freeBytes == null || totalBytes <= 0) {
    return undefined;
  }
  return (totalBytes - freeBytes) / totalBytes;
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
  const used = usedFraction(totalBytes, freeBytes);
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
export function renderSystemSection(props: SystemSectionProps) {
  if (props.systemInfoUnavailable) {
    return nothing;
  }
  const info = props.systemInfo;
  const placeholder = props.systemInfoLoading
    ? html`<span class="skeleton config-host__placeholder" aria-hidden="true"></span>`
    : "—";
  const hostTitle = info && info.hostname !== info.machineName ? info.hostname : undefined;
  const address = info?.lanAddress
    ? `${info.lanAddress}${info.port == null ? "" : `:${info.port}`}`
    : undefined;
  const stats = info
    ? buildSystemStats(info)
    : ["cpu", "memory", "disk"].map((kind) => ({
        label: t(`quickSettings.system.${kind}`),
        value: placeholder,
      }));

  // Host identity and metered stats use a custom two-column grid with aligned row padding.
  const sectionProps: SettingsSectionProps = {
    title: t("quickSettings.system.gatewayHost"),
    actions: info
      ? renderSettingsStatus({
          kind: "ok",
          label: t("quickSettings.system.up", { duration: formatDurationHuman(info.uptimeMs) }),
        })
      : undefined,
  };
  return html`
    <div id=${CONNECTION_SETTINGS_TARGET_IDS.host} aria-busy=${Boolean(props.systemInfoLoading)}>
      ${renderSettingsSection(
        sectionProps,
        html`
          <div class="config-host">
            <div class="config-host__identity">
              <div class="config-host__name" title=${hostTitle ?? ""}>
                ${info?.machineName ?? placeholder}
              </div>
              <div class="config-host__meta">
                ${info ? `${info.osLabel} · ${info.arch}` : placeholder}
              </div>
              <div class="config-host__meta">
                ${
                  info
                    ? t("quickSettings.system.runtime", {
                        version: info.nodeVersion,
                        pid: String(info.pid),
                      })
                    : placeholder
                }
              </div>
              ${address ? html`<code class="config-host__address">${address}</code>` : nothing}
            </div>
            <div class="config-host__stats">${stats.map(renderSystemStat)}</div>
          </div>
        `,
      )}
    </div>
  `;
}
