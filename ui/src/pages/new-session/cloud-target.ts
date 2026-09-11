import { html, nothing, type TemplateResult } from "lit";
import "../../components/tooltip.ts";
import type { EnvironmentsListResult } from "../../../../packages/gateway-protocol/src/index.js";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import { toolIcons } from "../../components/icons-tools.ts";
import { icons } from "../../components/icons.ts";
import { renderPicker } from "../../components/select-picker.ts";
import { t } from "../../i18n/index.ts";
import type {
  DraftCloudProfile,
  DraftEnvironment,
  DraftMachineOption,
  DraftOperatingSystem,
} from "./discovery.ts";
import {
  cloudMachinesForOs,
  defaultCloudOs,
  readDraftCloudProfiles,
  readDraftEnvironments,
} from "./discovery.ts";

export async function requestPlaceCatalog(
  client: Pick<GatewayBrowserClient, "request">,
  runtimeId?: string,
): Promise<{ profiles: DraftCloudProfile[]; environments: DraftEnvironment[] }> {
  const result = await client.request<EnvironmentsListResult>(
    "environments.list",
    runtimeId ? { runtimeId } : {},
  );
  return {
    profiles: readDraftCloudProfiles(result?.profiles),
    environments: readDraftEnvironments(result?.environments),
  };
}

type SessionMenuItemOptions = {
  value: string;
  label: string;
  description?: string;
  icon?: unknown;
  sub?: string;
  facts?: readonly string[];
  checked: boolean;
  disabled?: boolean;
  title?: string;
  keepOpen?: boolean;
  compact?: boolean;
  capacityLabel?: string;
  platform?: string;
  summary?: string;
  capabilityLabels?: readonly string[];
  hardware?: string;
  osControl?: TemplateResult;
  machineControl?: TemplateResult;
  interactive?: boolean;
  hideDetails?: boolean;
  remediation?: "enable-session-hosting" | "update-device";
  provider?: string;
  trust?: "persistent" | "disposable";
  onSelect: () => void;
};

function formatUnavailableReason(
  reason: string,
  remediation: SessionMenuItemOptions["remediation"],
) {
  if (remediation === "enable-session-hosting") {
    return html`<div>${t("newSession.sessionHostingAction")}</div>
      <code class="new-session-page__command">openclaw connect --service --session-host</code>`;
  }
  if (remediation === "update-device") {
    return html`<div>${t("newSession.updateAction")}</div>
      <code class="new-session-page__command">openclaw update</code>
      <div>${t("newSession.reconnectAction")}</div>
      <code class="new-session-page__command">openclaw node restart</code>`;
  }
  return reason;
}

function detailRow(icon: TemplateResult, text: string) {
  return html`<div class="new-session-page__card-row">
    <span class="new-session-page__card-icon" aria-hidden="true">${icon}</span><span>${text}</span>
  </div>`;
}

export function renderSessionMenuItem(params: SessionMenuItemOptions, submitting: boolean) {
  const unavailableReason = params.disabled ? params.title || params.description : undefined;
  const description = params.compact ? undefined : params.description;
  const accessibleBlocker = params.compact && params.disabled && !params.hideDetails;
  const row = html`
    <button
      type="button"
      class="session-menu__item ${
        description ? "session-menu__item--described" : ""
      } ${params.compact ? "new-session-page__environment-option" : ""}"
      data-value=${params.value}
      data-popover=${params.keepOpen || accessibleBlocker ? nothing : "close"}
      aria-pressed=${String(params.checked)}
      title=${params.compact ? nothing : (params.title ?? nothing)}
      ?disabled=${submitting || (Boolean(params.disabled) && !accessibleBlocker)}
      aria-disabled=${accessibleBlocker ? "true" : nothing}
      @click=${(event: MouseEvent) => {
        if (params.disabled) {
          event.preventDefault();
          event.stopPropagation();
          return;
        }
        params.onSelect();
      }}
    >
      ${
        params.icon
          ? html`<span class="session-menu__icon" aria-hidden="true">${params.icon}</span>`
          : nothing
      }
      <span class="session-menu__text">
        ${params.label}
        ${
          description
            ? html`<span class="session-menu__description">${description}</span>`
            : nothing
        }
      </span>
      ${
        !params.compact && params.facts?.length
          ? html`<span class="new-session-page__menu-meta">
              ${
                params.facts?.length
                  ? html`<span class="new-session-page__menu-facts">
                      ${params.facts.map(
                        (fact) => html`<span class="new-session-page__menu-fact">${fact}</span>`,
                      )}
                    </span>`
                  : nothing
              }
            </span>`
          : nothing
      }
      ${
        !params.compact && params.sub
          ? html`<span class="session-menu__sub">${params.sub}</span>`
          : nothing
      }

      <span class="session-menu__check" aria-hidden="true"
        >${params.checked ? icons.check : nothing}</span
      >
    </button>
  `;
  return params.compact && !params.hideDetails
    ? html`<openclaw-tooltip
        class="new-session-page__environment-details"
        placement="right-start"
        ?open-on-click=${accessibleBlocker || params.interactive}
      >
        ${row}
        <div slot="content" class="new-session-page__environment-card">
          ${
            unavailableReason
              ? html`<span>${formatUnavailableReason(unavailableReason, params.remediation)}</span>`
              : html`
                  <strong>${params.label}</strong>
                  ${params.summary ? detailRow(icons.info, params.summary) : nothing}
                  ${!params.osControl && params.platform ? detailRow(icons.layers, params.platform) : nothing}
                  ${params.sub ? detailRow(icons.info, params.sub) : nothing}
                  ${params.capabilityLabels?.length ? detailRow(toolIcons.puzzle, params.capabilityLabels.join(", ")) : nothing}
                  ${params.trust ? detailRow(params.trust === "persistent" ? icons.repeat : icons.clock, t(params.trust === "persistent" ? "newSession.persistentEnvironmentHint" : "newSession.disposableEnvironmentHint")) : nothing}
                  ${params.provider ? detailRow(icons.server, params.provider) : nothing}
                  ${!params.machineControl && params.hardware ? detailRow(toolIcons.cpu, params.hardware) : nothing}
                  ${[...new Set([params.description, ...(params.facts ?? []), params.provider && !params.disabled ? undefined : params.title].filter(Boolean))].map((detail) => detailRow(icons.info, detail!))}
                  ${params.osControl || params.machineControl ? html`<div class="new-session-page__card-fields">${params.osControl ?? nothing}${params.machineControl ?? nothing}</div>` : nothing}
                  ${params.capacityLabel ? html`<div class="new-session-page__card-row"><span class="new-session-page__card-icon" aria-hidden="true">${icons.activity}</span><span class="new-session-page__capacity-caption">${params.capacityLabel}</span></div>` : nothing}
                `
          }
        </div>
      </openclaw-tooltip>`
    : row;
}

export function renderConnectMachineMenuItem(params: { disabled: boolean; onSelect: () => void }) {
  return html`
    <div class="session-menu__separator" role="separator"></div>
    <button
      type="button"
      class="session-menu__item new-session-page__connect-machine"
      data-value="connect-machine"
      aria-pressed="false"
      ?disabled=${params.disabled}
      @click=${params.onSelect}
    >
      <span class="session-menu__icon" aria-hidden="true">${icons.link}</span>
      <span class="session-menu__text">${t("newSession.connectMachine")}</span>
    </button>
  `;
}

export function renderCloudProfileMenuItems(params: {
  profiles: readonly DraftCloudProfile[];
  selectedId: string;
  selectedOs?: string;
  selectedMachine?: string;
  onSelectOs?: (osId: string) => void;
  onSelectMachine?: (machineId: string) => void;
  submitting: boolean;
  icon?: unknown;
  disabled?: boolean;
  disabledReason?: string;
  profileDisabledReason?: (profile: DraftCloudProfile) => string | undefined;
  compact?: boolean;
  onSelect: (profileId: string) => void;
}) {
  return params.profiles.map((profile) => {
    const profileDisabledReason = params.profileDisabledReason?.(profile);
    const selected = params.selectedId === profile.id;
    const osId = (selected ? params.selectedOs : undefined) || defaultCloudOs(profile);
    const os = profile.operatingSystems?.find((option) => option.id === osId);
    const machines = cloudMachinesForOs(profile, osId);
    const machine =
      (selected && params.selectedMachine
        ? machines.find((option) => option.id === params.selectedMachine)
        : undefined) ?? machines.find((option) => option.default);

    return renderSessionMenuItem(
      {
        value: `cloud:${profile.id}`,
        label: t("newSession.cloudWorker", { profile: profile.id }),
        icon: params.icon,
        compact: params.compact,
        facts:
          !params.compact && profile.trust === "disposable"
            ? [t("newSession.environmentDisposable")]
            : !params.compact && profile.trust === "persistent"
              ? [t("newSession.environmentPersistent")]
              : undefined,
        trust: params.compact ? profile.trust : undefined,
        provider: params.compact ? profile.providerId : undefined,
        platform: params.compact ? os?.label : undefined,
        hardware: params.compact && machine ? machineShapeText(machine) : undefined,
        osControl:
          params.compact && selected && (profile.operatingSystems?.length ?? 0) >= 2
            ? renderCloudOsSelect({
                operatingSystems: profile.operatingSystems ?? [],
                selectedId: osId,
                submitting: params.submitting,
                onSelect: params.onSelectOs ?? (() => undefined),
              })
            : undefined,
        machineControl:
          params.compact && selected && machines.length > 0
            ? renderCloudMachineSelect({
                machines,
                selectedId: machine?.id ?? "",
                submitting: params.submitting,
                onSelect: params.onSelectMachine ?? (() => undefined),
              })
            : undefined,
        interactive: params.compact,
        keepOpen: params.compact,
        checked: params.selectedId === profile.id,
        disabled: params.disabled || Boolean(profileDisabledReason),
        title:
          (params.disabled ? params.disabledReason : profileDisabledReason) ??
          t("newSession.cloudWorkerProvider", { provider: profile.providerId }),
        onSelect: () => params.onSelect(profile.id),
      },
      params.submitting,
    );
  });
}

/** Machine shape as a picker sub-line; providers may report neither, one, or both numbers. */
function machineShapeText(machine: DraftMachineOption): string | undefined {
  const cpu = machine.cpu === undefined ? undefined : String(machine.cpu);
  const memory = machine.memoryGb === undefined ? undefined : String(machine.memoryGb);
  if (cpu && memory) {
    return t("newSession.machineShape", { cpu, memory });
  }
  if (cpu) {
    return t("newSession.machineCpu", { cpu });
  }
  return memory ? t("newSession.machineMemory", { memory }) : undefined;
}

export function renderCloudMachineSelect(params: {
  machines: readonly DraftMachineOption[];
  selectedId: string;
  submitting: boolean;
  onSelect: (machineId: string) => void;
}) {
  return html`<div class="new-session-page__card-field">
    <span>${t("newSession.machine")}</span
    >${renderPicker({ label: t("newSession.machine"), value: params.selectedId, disabled: params.submitting, options: params.machines.map((machine) => ({ value: machine.id, label: machineShapeText(machine) ?? machine.label })), onChange: params.onSelect })}
  </div>`;
}

export function renderCloudOsSelect(params: {
  operatingSystems: readonly DraftOperatingSystem[];
  selectedId: string;
  submitting: boolean;
  onSelect: (osId: string) => void;
}) {
  return html`<div class="new-session-page__card-field">
    <span>${t("newSession.operatingSystem")}</span
    >${renderPicker({ label: t("newSession.operatingSystem"), value: params.selectedId, disabled: params.submitting, options: params.operatingSystems.map((os) => ({ value: os.id, label: os.label, disabled: Boolean(os.disabledReason), description: os.disabledReason })), onChange: params.onSelect })}
  </div>`;
}

// The move-session dialog retains its existing menu-based choices.
export function renderCloudMachineMenuItems(params: {
  machines: readonly DraftMachineOption[];
  selectedId: string;
  submitting: boolean;
  onSelect: (machineId: string) => void;
}) {
  return params.machines.map((machine) =>
    renderSessionMenuItem(
      {
        value: `machine:${machine.id}`,
        label: machine.label,
        sub: machineShapeText(machine),
        facts: machine.default ? [t("newSession.machineDefault")] : undefined,
        checked: params.selectedId === machine.id,
        keepOpen: true,
        onSelect: () => params.onSelect(machine.id),
      },
      params.submitting,
    ),
  );
}

export function renderCloudOsMenuItems(params: {
  operatingSystems: readonly DraftOperatingSystem[];
  selectedId: string;
  submitting: boolean;
  onSelect: (osId: string) => void;
}) {
  return params.operatingSystems.map((os) =>
    renderSessionMenuItem(
      {
        value: `os:${os.id}`,
        label: os.label,
        description: os.disabledReason,
        disabled: Boolean(os.disabledReason),
        title: os.disabledReason,
        facts: os.default ? [t("newSession.machineDefault")] : undefined,
        checked: params.selectedId === os.id,
        keepOpen: true,
        onSelect: () => params.onSelect(os.id),
      },
      params.submitting,
    ),
  );
}
