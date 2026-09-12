import { html, nothing, type TemplateResult } from "lit";
import "../../components/tooltip.ts";
import type { EnvironmentsListResult } from "../../../../packages/gateway-protocol/src/index.js";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import { icons } from "../../components/icons.ts";
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
  selectedSummary?: string;
  hasSubmenu?: boolean;
  suggested?: boolean;
  capabilityLabels?: readonly string[];
  hardware?: string;
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
  const touchDetails = params.compact && !params.disabled && !params.hideDetails;
  const row = html`
    <button
      type="button"
      class="session-menu__item ${
        description ? "session-menu__item--described" : ""
      } ${params.compact ? "new-session-page__environment-option" : ""}"
      data-suggested=${params.suggested ? "true" : nothing}
      aria-description=${params.suggested ? t("newSession.machineDefault") : nothing}
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
          params.selectedSummary
            ? html`<span class="new-session-page__selected-summary"
                >${params.selectedSummary}</span
              >`
            : nothing
        }
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
      ${
        params.hasSubmenu
          ? html`<span class="new-session-page__submenu-chevron" aria-hidden="true"
              >${icons.chevronRight}</span
            >`
          : nothing
      }
    </button>
  `;
  return params.compact && !params.hideDetails
    ? html`<openclaw-tooltip
        class="new-session-page__environment-details"
        placement="right-start"
        ?open-on-click=${accessibleBlocker || touchDetails}
      >
        ${
          touchDetails
            ? html`<div class="new-session-page__environment-detail-trigger">
                ${row}
                <button
                  type="button"
                  class="new-session-page__touch-details"
                  aria-label=${t("newSession.environmentDetails", { name: params.label })}
                  ?disabled=${submitting}
                >
                  ${icons.info}
                </button>
              </div>`
            : row
        }
        <div slot="content" class="new-session-page__environment-card">
          ${
            unavailableReason
              ? html`<span>${formatUnavailableReason(unavailableReason, params.remediation)}</span>`
              : html`
                  <strong>${params.label}</strong>
                  ${params.summary ? detailRow(icons.info, params.summary) : nothing}
                  ${params.platform ? detailRow(icons.layers, params.platform) : nothing}
                  ${params.sub ? detailRow(icons.info, params.sub) : nothing}
                  ${
                    params.capabilityLabels?.length
                      ? detailRow(icons.info, params.capabilityLabels.join(", "))
                      : nothing
                  }
                  ${
                    params.trust
                      ? detailRow(
                          params.trust === "persistent" ? icons.repeat : icons.clock,
                          t(
                            params.trust === "persistent"
                              ? "newSession.persistentEnvironmentHint"
                              : "newSession.disposableEnvironmentHint",
                          ),
                        )
                      : nothing
                  }
                  ${params.provider ? detailRow(icons.server, params.provider) : nothing}
                  ${params.hardware ? detailRow(icons.info, params.hardware) : nothing}
                  ${[
                    ...new Set(
                      [
                        params.description,
                        ...(params.facts ?? []),
                        params.provider && !params.disabled ? undefined : params.title,
                      ].filter(Boolean),
                    ),
                  ].map((detail) => detailRow(icons.info, detail!))}
                  ${
                    params.capacityLabel
                      ? html`<div class="new-session-page__card-row">
                          <span class="new-session-page__card-icon" aria-hidden="true"
                            >${icons.activity}</span
                          ><span class="new-session-page__capacity-caption"
                            >${params.capacityLabel}</span
                          >
                        </div>`
                      : nothing
                  }
                `
          }
        </div>
      </openclaw-tooltip>`
    : row;
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
  onSelect: (profileId: string, useDefaults?: boolean) => void;
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

    const item = renderSessionMenuItem(
      {
        value: `cloud:${profile.id}`,
        label: params.compact ? profile.id : t("newSession.cloudWorker", { profile: profile.id }),
        hasSubmenu:
          params.compact &&
          !params.disabled &&
          !profileDisabledReason &&
          ((profile.operatingSystems?.filter((option) => !option.disabledReason).length ?? 0) > 0 ||
            machines.length > 0),
        selectedSummary:
          params.compact && selected
            ? [os?.label, machine?.label].filter(Boolean).join(" · ")
            : undefined,
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
        hideDetails: params.compact && !params.disabled && !profileDisabledReason,
        keepOpen: params.compact,
        checked: params.selectedId === profile.id,
        disabled: params.disabled || Boolean(profileDisabledReason),
        title:
          (params.disabled ? params.disabledReason : profileDisabledReason) ??
          t("newSession.cloudWorkerProvider", { provider: profile.providerId }),
        onSelect: () =>
          params.compact && !selected
            ? params.onSelect(profile.id, true)
            : params.onSelect(profile.id),
      },
      params.submitting,
    );
    return params.compact &&
      !params.disabled &&
      !profileDisabledReason &&
      ((profile.operatingSystems?.filter((option) => !option.disabledReason).length ?? 0) > 0 ||
        machines.length > 0)
      ? html`<openclaw-tooltip
          class="new-session-page__environment-details new-session-page__cloud-config-card"
          placement="right"
          open-on-click
        >
          ${item}
          <div slot="content">
            ${renderCloudConfiguration({
              profile,
              operatingSystems: profile.operatingSystems ?? [],
              machines,
              suggested: !selected,
              selectedOs: selected ? osId : "",
              selectedMachine: selected ? (machine?.id ?? "") : "",
              submitting: params.submitting,
              onSelectOs: (id) => {
                if (!selected) {
                  params.onSelect(profile.id, true);
                }
                params.onSelectOs?.(id);
              },
              onSelectMachine: (id) => {
                if (!selected) {
                  params.onSelect(profile.id, true);
                }
                params.onSelectMachine?.(id);
              },
            })}
          </div>
        </openclaw-tooltip>`
      : item;
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

function renderCloudConfiguration(params: {
  profile: DraftCloudProfile;
  suggested?: boolean;
  operatingSystems: readonly DraftOperatingSystem[];
  machines: readonly DraftMachineOption[];
  selectedOs: string;
  selectedMachine: string;
  submitting: boolean;
  onSelectOs: (id: string) => void;
  onSelectMachine: (id: string) => void;
}) {
  const operatingSystems = params.operatingSystems.filter((os) => !os.disabledReason);
  const fixedOs = operatingSystems.length === 1 ? operatingSystems[0] : undefined;
  const fixedMachine = params.machines.length === 1 ? params.machines[0] : undefined;
  return html`<section
    class="new-session-page__cloud-configuration"
    aria-label=${params.profile.id}
  >
    <div class="new-session-page__environment-heading">${t("newSession.operatingSystem")}</div>
    <div
      class="new-session-page__cloud-choice-list"
      role="group"
      aria-label=${t("newSession.operatingSystem")}
    >
      ${
        fixedOs
          ? html`<span class="new-session-page__fixed-os" data-value=${`os:${fixedOs.id}`}
              >${fixedOs.label}</span
            >`
          : renderCloudOsMenuItems({
              operatingSystems,
              selectedId: params.selectedOs,
              suggestedId: params.suggested ? defaultCloudOs(params.profile) : undefined,
              submitting: params.submitting,
              onSelect: params.onSelectOs,
            })
      }
    </div>
    ${
      params.machines.length
        ? html`<div class="new-session-page__environment-heading">${t("newSession.machine")}</div>
            <div
              class="new-session-page__cloud-choice-list"
              role="group"
              aria-label=${t("newSession.machine")}
            >
              ${
                fixedMachine
                  ? renderFixedMachine(fixedMachine)
                  : renderCloudMachineMenuItems({
                      machines: params.machines,
                      selectedId: params.selectedMachine,
                      suggestedId: params.suggested
                        ? params.machines.find((machine) => machine.default)?.id
                        : undefined,
                      submitting: params.submitting,
                      onSelect: params.onSelectMachine,
                    })
              }
            </div>`
        : nothing
    }
  </section>`;
}

function renderFixedMachine(machine: DraftMachineOption) {
  const shape = machineShapeText(machine);
  return html`<span class="new-session-page__fixed-machine" data-value=${`machine:${machine.id}`}>
    <span>${machine.label}</span>${shape ? html`<span>${shape}</span>` : nothing}
  </span>`;
}

// The move-session dialog retains its existing menu-based choices.
export function renderCloudMachineMenuItems(params: {
  machines: readonly DraftMachineOption[];
  selectedId: string;
  suggestedId?: string;
  submitting: boolean;
  onSelect: (machineId: string) => void;
}) {
  return params.machines.map((machine) =>
    renderSessionMenuItem(
      {
        suggested: params.suggestedId === machine.id,
        value: `machine:${machine.id}`,
        label: machine.label,
        sub: machineShapeText(machine),
        checked:
          params.selectedId === machine.id ||
          (!params.selectedId && params.suggestedId === machine.id),
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
  suggestedId?: string;
  submitting: boolean;
  onSelect: (osId: string) => void;
}) {
  return params.operatingSystems.map((os) =>
    renderSessionMenuItem(
      {
        suggested: params.suggestedId === os.id,
        value: `os:${os.id}`,
        label: os.label,
        description: os.disabledReason,
        disabled: Boolean(os.disabledReason),
        title: os.disabledReason,
        checked:
          params.selectedId === os.id || (!params.selectedId && params.suggestedId === os.id),
        keepOpen: true,
        onSelect: () => params.onSelect(os.id),
      },
      params.submitting,
    ),
  );
}
