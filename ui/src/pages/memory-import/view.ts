import { html, nothing } from "lit";
import type {
  MemoryMigrationItem,
  MemoryMigrationProviderPlan,
  MigrationsMemoryApplyResult,
  MigrationsMemoryPlanResult,
} from "../../../../packages/gateway-protocol/src/schema/migrations.js";
import type { GatewayAgentRow } from "../../../../src/shared/session-types.js";
import "../../components/agent-select-registration.ts";
import "../../components/modal-dialog.ts";
import { icons } from "../../components/icons.ts";
import { renderProviderBrandIcon } from "../../components/provider-icon.ts";
import {
  renderSettingsEmpty,
  renderSettingsPage,
  renderSettingsRow,
  renderSettingsSection,
  renderSettingsStatus,
  renderSettingsToggleRow,
  renderSettingsValue,
} from "../../components/settings-ui.ts";
import { t } from "../../i18n/index.ts";
import { registerMemoryImportEnglish } from "../../i18n/locales/en-memory-import.ts";
import { normalizeAgentLabel } from "../../lib/agents/display.ts";
import { formatUiExternalText } from "../../lib/format-error.ts";
import "../../styles/memory-import.css";

registerMemoryImportEnglish();

type MemoryCollection = {
  label: string;
  items: MemoryMigrationItem[];
};

export type SessionBackfillGatewayResult = {
  days: number;
  candidates: number;
  perDay: Array<{ day: string; candidateCount: number; sample: string[] }>;
  staged: number;
  truncated?: boolean;
  cursor?: { advanced: boolean; exhausted: boolean; hasMore: boolean };
};

export type SessionBackfillProgress = {
  days: number;
  candidates: number;
  staged: number;
  complete: boolean;
};

export type SessionBackfillRollbackResult = {
  removedDiaryEntries: number;
  removedStagedEntries: number;
};

type MemoryImportViewProps = {
  connected: boolean;
  canAdmin: boolean;
  agents: GatewayAgentRow[];
  selectedAgentId: string | null;
  plan: MigrationsMemoryPlanResult | null;
  loading: boolean;
  error: string | null;
  applyError: string | null;
  replaceExisting: boolean;
  selectedByProvider: Record<string, string[]>;
  applyingProviderId: string | null;
  pendingProviderId: string | null;
  lastResults: Record<string, MigrationsMemoryApplyResult>;
  backfillAvailable: boolean;
  backfillFrom: string;
  backfillTo: string;
  backfillBusy: "preview" | "apply" | "rollback" | null;
  backfillError: string | null;
  backfillPreview: SessionBackfillGatewayResult | null;
  backfillProgress: SessionBackfillProgress | null;
  backfillRollbackResult: SessionBackfillRollbackResult | null;
  backfillRollbackPending: boolean;
  onSelectAgent: (agentId: string) => void;
  onReplaceExisting: (enabled: boolean) => void;
  onRefresh: () => void;
  onToggleCollection: (providerId: string, itemIds: readonly string[], selected: boolean) => void;
  onRequestImport: (providerId: string) => void;
  onConfirmImport: () => void;
  onCancelImport: () => void;
  onBackfillFromChange: (value: string) => void;
  onBackfillToChange: (value: string) => void;
  onBackfillPreview: () => void;
  onBackfillApply: () => void;
  onBackfillRollbackRequest: () => void;
  onBackfillRollbackConfirm: () => void;
  onBackfillRollbackCancel: () => void;
};

function detailString(item: MemoryMigrationItem, key: string): string | undefined {
  const value = item.details?.[key];
  return typeof value === "string" && value.trim() ? value : undefined;
}

function groupMemoryItems(items: readonly MemoryMigrationItem[]): MemoryCollection[] {
  const groups = new Map<string, MemoryCollection>();
  for (const item of items) {
    const id = detailString(item, "collectionId") ?? item.id;
    const label =
      detailString(item, "collectionLabel") ??
      detailString(item, "sourceLabel") ??
      t("memoryImport.unknownCollection");
    const group = groups.get(id) ?? { label, items: [] };
    group.items.push(item);
    groups.set(id, group);
  }
  return [...groups.values()].toSorted((left, right) => left.label.localeCompare(right.label));
}

function providerLabel(provider: MemoryMigrationProviderPlan): string {
  return provider.providerId === "claude" ? t("memoryImport.claudeCode") : provider.label;
}

function countLabel(key: "fileCount" | "backfill.processedDayCount", count: number): string {
  return t(`memoryImport.${key}${count === 1 ? "One" : ""}`, {
    count: String(count),
  });
}

function artifactLabel(item: MemoryMigrationItem): string {
  const relativePath = detailString(item, "relativePath");
  if (relativePath) {
    return relativePath;
  }
  const pathValue = item.target ?? item.source ?? item.id;
  return pathValue.split(/[\\/]/u).at(-1) ?? pathValue;
}

// Collection review keeps custom markup: a select-all checkbox plus a
// collapsible per-file status list has no settings-ui primitive.
function renderCollection(
  provider: MemoryMigrationProviderPlan,
  collection: MemoryCollection,
  selectedIds: ReadonlySet<string>,
  onToggle: MemoryImportViewProps["onToggleCollection"],
  disabled: boolean,
) {
  const selectable = collection.items.filter((item) => item.status === "planned");
  const selectableIds = selectable.map((item) => item.id);
  const checked = selectableIds.length > 0 && selectableIds.every((id) => selectedIds.has(id));
  const conflicts = collection.items.filter((item) => item.status === "conflict").length;
  return html`
    <div class="settings-row settings-row--stacked memory-import__collection">
      <div class="memory-import__collection-header">
        <label class="memory-import__collection-choice">
          <input
            type="checkbox"
            .checked=${checked}
            ?disabled=${selectableIds.length === 0 || disabled}
            @change=${(event: Event) =>
              onToggle(
                provider.providerId,
                selectableIds,
                (event.currentTarget as HTMLInputElement).checked,
              )}
          />
          <span>
            <strong>${collection.label}</strong>
            <small>${countLabel("fileCount", collection.items.length)}</small>
          </span>
        </label>
        ${
          conflicts > 0
            ? renderSettingsStatus({
                kind: "warn",
                label: t("memoryImport.alreadyImported", { count: String(conflicts) }),
              })
            : nothing
        }
      </div>
      <details ?open=${collection.items.length <= 4}>
        <summary>${t("memoryImport.reviewFiles")}</summary>
        <ul class="memory-import__files">
          ${collection.items.map(
            (item) => html`
              <li>
                <span class="memory-import__file-icon" aria-hidden="true">${icons.fileText}</span>
                <code title=${item.source ?? artifactLabel(item)}>${artifactLabel(item)}</code>
                <span class="memory-import__file-status memory-import__file-status--${item.status}">
                  ${
                    item.status === "planned"
                      ? t("memoryImport.ready")
                      : item.status === "conflict"
                        ? t("memoryImport.existing")
                        : item.status
                  }
                </span>
              </li>
            `,
          )}
        </ul>
      </details>
    </div>
  `;
}

// Apply results keep custom markup: nested issue and recovery-artifact lists
// are a report, not a settings row.
function renderResult(result: MigrationsMemoryApplyResult | undefined) {
  if (!result) {
    return nothing;
  }
  const incomplete = result.summary.errors > 0 || result.summary.conflicts > 0;
  const resultDetailItems = result.items.filter(
    (item) =>
      item.status === "error" ||
      item.status === "conflict" ||
      detailString(item, "recoveryRecordPath") !== undefined,
  );
  return html`
    <div
      class="settings-row settings-row--stacked memory-import__result ${
        incomplete ? "memory-import__result--incomplete" : ""
      }"
      role=${incomplete ? "alert" : "status"}
    >
      <span aria-hidden="true">${incomplete ? icons.alertTriangle : icons.check}</span>
      <div>
        <strong>
          ${t(incomplete ? "memoryImport.importIncomplete" : "memoryImport.importComplete")}
        </strong>
        <span>
          ${
            incomplete
              ? t("memoryImport.importedWithIssues", {
                  conflicts: String(result.summary.conflicts),
                  errors: String(result.summary.errors),
                  migrated: String(result.summary.migrated),
                })
              : t("memoryImport.importedCount", { count: String(result.summary.migrated) })
          }
        </span>
        ${
          result.reportDir
            ? html`<span class="memory-import__result-path">
                ${t("memoryImport.reportSaved")}:
                <code title=${result.reportDir}>${result.reportDir}</code>
              </span>`
            : nothing
        }
        ${
          resultDetailItems.length > 0
            ? html`<ul class="memory-import__result-issues">
                ${resultDetailItems.map(
                  (item) => html`<li>
                    <strong>${artifactLabel(item)}</strong>
                    <span>${formatUiExternalText(item.reason ?? item.message, item.status)}</span>
                    ${(
                      [
                        ["memoryImport.recoveryFile", "recoveryPath"],
                        ["memoryImport.recoveryJournal", "recoveryRecordPath"],
                        ["memoryImport.itemBackup", "backupPath"],
                      ] as const
                    ).map(([label, key]) => {
                      const path = detailString(item, key);
                      return path
                        ? html`<span class="memory-import__result-artifact">
                            <span>${t(label)}</span>
                            <code title=${path}>${path}</code>
                          </span>`
                        : nothing;
                    })}
                  </li>`,
                )}
              </ul>`
            : nothing
        }
      </div>
    </div>
  `;
}

function renderProvider(props: MemoryImportViewProps, provider: MemoryMigrationProviderPlan) {
  const selectedIds = new Set(props.selectedByProvider[provider.providerId] ?? []);
  const groups = groupMemoryItems(provider.items);
  const applying = props.applyingProviderId === provider.providerId;
  const disabled =
    props.loading ||
    props.applyingProviderId !== null ||
    props.error !== null ||
    props.backfillBusy === "apply" ||
    props.backfillBusy === "rollback" ||
    props.backfillRollbackPending;
  const rows = provider.error
    ? html`<div class="callout danger" role="alert">${formatUiExternalText(provider.error)}</div>`
    : !provider.found
      ? renderSettingsEmpty(provider.message ?? t("memoryImport.noMemoryFound"))
      : html`
          ${(
            [
              ["memoryImport.source", provider.source],
              ["memoryImport.destination", provider.target && `${provider.target}/memory/imports/`],
            ] as const
          ).map(([title, path]) =>
            path
              ? renderSettingsRow({
                  title: t(title),
                  control: renderSettingsValue(path, { mono: true }),
                })
              : nothing,
          )}
          ${groups.map((group) =>
            renderCollection(provider, group, selectedIds, props.onToggleCollection, disabled),
          )}
          ${renderSettingsRow({
            title:
              selectedIds.size > 0
                ? t("memoryImport.selectedCount", { count: String(selectedIds.size) })
                : t("memoryImport.selectAtLeastOne"),
            control: html`
              <button
                class="btn primary"
                data-test-id="memory-import-provider-button"
                ?disabled=${selectedIds.size === 0 || disabled}
                @click=${() => props.onRequestImport(provider.providerId)}
              >
                ${applying ? t("common.importing") : t("memoryImport.importSelected")}
              </button>
            `,
          })}
        `;
  return html`
    <div data-provider-id=${provider.providerId}>
      ${renderSettingsSection(
        {
          title: html`<span class="memory-import__provider-title">
            ${renderProviderBrandIcon(provider.providerId, {
              className: "memory-import__provider-icon",
            })}
            ${providerLabel(provider)}
          </span>`,
          description: t(
            provider.providerId === "codex"
              ? "memoryImport.codexDescription"
              : provider.providerId === "claude"
                ? "memoryImport.claudeDescription"
                : "memoryImport.providerFallback",
          ),
          actions: renderSettingsStatus({
            kind: provider.found ? "ok" : "muted",
            label: provider.found
              ? countLabel("fileCount", provider.items.length)
              : t("memoryImport.notFound"),
          }),
        },
        html`${rows}${renderResult(props.lastResults[provider.providerId])}`,
      )}
    </div>
  `;
}

// The confirmation modal reuses the shared exec-approval dialog anatomy, not
// the settings design language.
function renderConfirmation(props: MemoryImportViewProps, backfill = false) {
  const provider = backfill
    ? undefined
    : props.plan?.providers.find((candidate) => candidate.providerId === props.pendingProviderId);
  if (backfill ? !props.backfillRollbackPending : !provider) {
    return nothing;
  }
  const title = provider
    ? t("memoryImport.confirmTitle", { provider: providerLabel(provider) })
    : t("memoryImport.backfill.rollbackConfirmTitle");
  const description = provider
    ? t("memoryImport.confirmDescription", {
        count: String(props.selectedByProvider[provider.providerId]?.length ?? 0),
      })
    : t("memoryImport.backfill.rollbackConfirmDescription");
  const busy = props.applyingProviderId !== null || (backfill && props.backfillBusy !== null);
  const onCancel = backfill ? props.onBackfillRollbackCancel : props.onCancelImport;
  return html`
    <openclaw-modal-dialog
      label=${title}
      description=${description}
      @modal-cancel=${
        backfill
          ? onCancel
          : () => {
              if (props.applyingProviderId === null) {
                onCancel();
              }
            }
      }
    >
      <div class="exec-approval-card memory-import__confirm">
        <div class="exec-approval-header">
          <div>
            <div class="exec-approval-title">${title}</div>
            <div class="exec-approval-sub">${description}</div>
          </div>
        </div>
        <div class="callout ${backfill || props.replaceExisting ? "warn" : ""}">
          ${t(backfill ? "memoryImport.backfill.rollbackWarning" : props.replaceExisting ? "memoryImport.confirmReplace" : "memoryImport.confirmBackup")}
        </div>
        <div class="exec-approval-actions">
          <button
            class="btn ${backfill ? "danger" : "primary"}"
            data-test-id=${backfill ? "memory-backfill-rollback-confirm" : "memory-import-confirm"}
            ?disabled=${busy}
            @click=${backfill ? props.onBackfillRollbackConfirm : props.onConfirmImport}
          >
            ${t(backfill ? "memoryImport.backfill.rollback" : "memoryImport.confirmImport")}
          </button>
          <button class="btn" ?disabled=${busy} @click=${onCancel}>${t("common.cancel")}</button>
        </div>
      </div>
    </openclaw-modal-dialog>
  `;
}

function renderIntroSection(props: MemoryImportViewProps) {
  const busy = props.loading || props.applyingProviderId !== null || props.backfillBusy !== null;
  return renderSettingsSection(
    {
      title: t("memoryImport.title"),
      description: t("memoryImport.subtitle"),
      actions: html`
        <button class="btn btn--sm" ?disabled=${busy} @click=${props.onRefresh}>
          ${props.loading ? t("common.refreshing") : t("common.refresh")}
        </button>
      `,
    },
    html`
      ${
        props.agents.length > 1
          ? renderSettingsRow({
              title: t("memoryImport.agent"),
              control: html`
                <openclaw-agent-select
                  class="agent-select--settings"
                  name="memory-import-agent"
                  .options=${props.agents.map((agent) => ({
                    value: agent.id,
                    label: normalizeAgentLabel(agent),
                    agent,
                  }))}
                  .value=${props.selectedAgentId ?? ""}
                  .accessibleLabel=${t("memoryImport.agent")}
                  .disabled=${busy}
                  .onSelect=${props.onSelectAgent}
                ></openclaw-agent-select>
              `,
            })
          : nothing
      }
      ${renderSettingsToggleRow({
        title: t("memoryImport.replaceExisting"),
        description: t("memoryImport.replaceHint"),
        checked: props.replaceExisting,
        disabled: busy,
        onChange: (enabled) => props.onReplaceExisting(enabled),
      })}
    `,
  );
}

function renderBackfillSection(props: MemoryImportViewProps) {
  const busy = props.backfillBusy !== null || props.applyingProviderId !== null;
  const result = props.backfillPreview;
  const progress = props.backfillProgress;
  const rollback = props.backfillRollbackResult;
  const reports = [
    progress && {
      className: "memory-import__backfill-progress",
      title: progress.complete
        ? t("memoryImport.backfill.complete", { count: String(progress.staged) })
        : t("memoryImport.backfill.progress", {
            days: String(progress.days),
            staged: String(progress.staged),
          }),
      detail: html`${t("memoryImport.backfill.processedCandidates", {
        count: String(progress.candidates),
      })}
      · ${countLabel("backfill.processedDayCount", progress.days)}`,
    },
    rollback && {
      className: "",
      title: t("memoryImport.backfill.rollbackComplete"),
      detail: t("memoryImport.backfill.rollbackCounts", {
        diary: String(rollback.removedDiaryEntries),
        staged: String(rollback.removedStagedEntries),
      }),
    },
  ];
  const dateInput = (label: string, value: string, onInput: (value: string) => void) => html`<label>
    <span>${label}</span>
    <input
      class="input"
      type="date"
      .value=${value}
      ?disabled=${busy}
      @input=${(event: Event) => onInput((event.currentTarget as HTMLInputElement).value)}
    />
  </label>`;
  const actionButton = (
    action: string,
    className: string,
    label: string,
    onClick: () => void,
  ) => html`<button
    class=${className}
    data-test-id=${`memory-backfill-${action}`}
    ?disabled=${busy}
    @click=${onClick}
  >
    ${label}
  </button>`;
  return html`
    <div data-test-id="memory-session-backfill">
      ${renderSettingsSection(
        {
          title: t("memoryImport.backfill.title"),
          description: t("memoryImport.backfill.subtitle"),
        },
        html`
          ${
            props.backfillAvailable
              ? html`
                  ${renderSettingsRow({
                    title: t("memoryImport.backfill.dateRange"),
                    description: t("memoryImport.backfill.dateRangeHint"),
                    control: html`<div class="memory-import__backfill-dates">
                      ${dateInput(t("memoryImport.backfill.from"), props.backfillFrom, props.onBackfillFromChange)}
                      ${dateInput(t("memoryImport.backfill.to"), props.backfillTo, props.onBackfillToChange)}
                    </div>`,
                  })}
                  ${renderSettingsRow({
                    title: t("memoryImport.backfill.actions"),
                    control: html`<div class="memory-import__backfill-actions">
                      ${actionButton("preview", "btn", t(props.backfillBusy === "preview" ? "memoryImport.backfill.previewing" : "memoryImport.backfill.preview"), props.onBackfillPreview)}
                      ${actionButton("apply", "btn primary", t(props.backfillBusy === "apply" ? "memoryImport.backfill.applying" : "memoryImport.backfill.apply"), props.onBackfillApply)}
                      ${actionButton("rollback", "btn danger", t("memoryImport.backfill.rollback"), props.onBackfillRollbackRequest)}
                    </div>`,
                  })}
                  ${
                    props.backfillError
                      ? html`<div class="callout danger" role="alert">${props.backfillError}</div>`
                      : nothing
                  }
                  ${
                    result
                      ? html`<div
                          class="settings-row settings-row--stacked memory-import__backfill-preview"
                        >
                          <strong role="status">
                            ${t("memoryImport.backfill.previewSummary", {
                              candidates: String(result.candidates),
                              days: String(result.days),
                            })}
                          </strong>
                          ${
                            result.perDay.length > 0
                              ? html`<ul>
                                  ${result.perDay.map(
                                    (day) => html`<li>
                                      <div>
                                        <strong>${day.day}</strong>
                                        <span>
                                          ${t("memoryImport.backfill.candidateCount", {
                                            count: String(day.candidateCount),
                                          })}
                                        </span>
                                      </div>
                                      ${
                                        day.sample.length > 0
                                          ? html`<ul>
                                              ${day.sample.map((sample) => html`<li>${sample}</li>`)}
                                            </ul>`
                                          : nothing
                                      }
                                    </li>`,
                                  )}
                                </ul>`
                              : html`<span>${t("memoryImport.backfill.noCandidates")}</span>`
                          }
                          ${
                            result.truncated
                              ? html`<div class="callout warn">
                                  ${t("memoryImport.backfill.previewTruncated")}
                                </div>`
                              : nothing
                          }
                        </div>`
                      : nothing
                  }
                  ${reports.map((report) =>
                    report
                      ? html`<div
                          class=${`settings-row settings-row--stacked${report.className ? ` ${report.className}` : ""}`}
                          role="status"
                        >
                          <strong>${report.title}</strong>
                          <span>${report.detail}</span>
                        </div>`
                      : nothing,
                  )}
                `
              : renderSettingsEmpty(t("memoryImport.backfill.unavailable"))
          }
        `,
      )}
      ${renderConfirmation(props, true)}
    </div>
  `;
}

export function renderMemoryImport(props: MemoryImportViewProps) {
  if (!props.connected) {
    return renderSettingsPage(renderSettingsEmpty(t("memoryImport.disconnected")));
  }
  if (!props.canAdmin) {
    return renderSettingsPage(renderSettingsEmpty(t("memoryImport.adminRequired")));
  }
  return html`
    <div class="memory-import" data-test-id="memory-import-page">
      ${renderSettingsPage(html`
        ${renderIntroSection(props)} ${renderBackfillSection(props)}
        ${[props.error, props.applyError].map((error) =>
          error ? html`<div class="callout danger" role="alert">${error}</div>` : nothing,
        )}
        ${
          props.loading && !props.plan
            ? html`<div class="settings-group memory-import__loading" aria-busy="true">
                <div class="skeleton memory-import__skeleton"></div>
                <div class="skeleton memory-import__skeleton"></div>
              </div>`
            : (props.plan?.providers ?? []).map((provider) => renderProvider(props, provider))
        }
        ${renderConfirmation(props)}
      `)}
    </div>
  `;
}
