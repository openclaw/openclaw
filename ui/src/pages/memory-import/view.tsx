import { createMemo, For, Show } from "solid-js";
import type {
  MemoryMigrationItem,
  MemoryMigrationProviderPlan,
  MigrationsMemoryApplyResult,
} from "../../../../packages/gateway-protocol/src/schema/migrations.js";
import "../../components/agent-select-registration.ts";
import "../../components/modal-dialog.ts";
import { Icon } from "../../components/solid/icon.tsx";
import { ProviderBrandIcon } from "../../components/solid/provider-icon.tsx";
import {
  SettingsEmpty,
  SettingsPage,
  SettingsRow,
  SettingsSection,
  SettingsStatus,
  SettingsToggleRow,
  SettingsValue,
} from "../../components/solid/settings-ui.tsx";
import { registerMemoryImportEnglish } from "../../i18n/locales/en-memory-import.ts";
import { normalizeAgentLabel } from "../../lib/agents/display.ts";
import { formatUiExternalText } from "../../lib/format-error.ts";
import { registerEnglishCatalog, t } from "../../lib/reactive/i18n.ts";
import type { MemoryImportViewProps } from "./view-types.ts";
import "../../styles/memory-import.css";

registerEnglishCatalog(registerMemoryImportEnglish);

type AgentSelectElement = HTMLElementTagNameMap["openclaw-agent-select"];

declare module "@solidjs/web" {
  namespace JSX {
    interface IntrinsicElements {
      "openclaw-agent-select": HTMLAttributes<AgentSelectElement> & {
        name?: string;
        "prop:options": AgentSelectElement["options"];
        "prop:value": string;
        "prop:accessibleLabel": string;
        "prop:disabled": boolean;
        "prop:onSelect": AgentSelectElement["onSelect"];
      };
    }
  }
}

type MemoryCollection = {
  label: string;
  items: MemoryMigrationItem[];
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

function Collection(props: {
  provider: MemoryMigrationProviderPlan;
  collection: MemoryCollection;
  selectedIds: ReadonlySet<string>;
  onToggle: MemoryImportViewProps["onToggleCollection"];
  disabled: boolean;
}) {
  const selectableIds = createMemo(() =>
    props.collection.items.filter((item) => item.status === "planned").map((item) => item.id),
  );
  const checked = () =>
    selectableIds().length > 0 && selectableIds().every((id) => props.selectedIds.has(id));
  const conflicts = () =>
    props.collection.items.filter((item) => item.status === "conflict").length;
  return (
    <div class="settings-row settings-row--stacked memory-import__collection">
      <div class="memory-import__collection-header">
        <label class="memory-import__collection-choice">
          <input
            type="checkbox"
            checked={checked()}
            disabled={selectableIds().length === 0 || props.disabled}
            onChange={(event) =>
              props.onToggle(
                props.provider.providerId,
                selectableIds(),
                event.currentTarget.checked,
              )
            }
          />
          <span>
            <strong>{props.collection.label}</strong>
            <small>{countLabel("fileCount", props.collection.items.length)}</small>
          </span>
        </label>
        <Show when={conflicts() > 0}>
          <SettingsStatus
            kind="warn"
            label={t("memoryImport.alreadyImported", { count: String(conflicts()) })}
          />
        </Show>
      </div>
      <details open={props.collection.items.length <= 4}>
        <summary>{t("memoryImport.reviewFiles")}</summary>
        <ul class="memory-import__files">
          <For each={props.collection.items} keyed={(item) => item.id}>
            {(item) => (
              <li>
                <span class="memory-import__file-icon" aria-hidden="true">
                  <Icon name="fileText" />
                </span>
                <code title={item().source ?? artifactLabel(item())}>{artifactLabel(item())}</code>
                <span
                  class={`memory-import__file-status memory-import__file-status--${item().status}`}
                >
                  {item().status === "planned"
                    ? t("memoryImport.ready")
                    : item().status === "conflict"
                      ? t("memoryImport.existing")
                      : item().status}
                </span>
              </li>
            )}
          </For>
        </ul>
      </details>
    </div>
  );
}

function Result(props: { result: MigrationsMemoryApplyResult }) {
  const incomplete = () => props.result.summary.errors > 0 || props.result.summary.conflicts > 0;
  const details = () =>
    props.result.items.filter(
      (item) =>
        item.status === "error" ||
        item.status === "conflict" ||
        detailString(item, "recoveryRecordPath") !== undefined,
    );
  return (
    <div
      class={[
        "settings-row settings-row--stacked memory-import__result",
        { "memory-import__result--incomplete": incomplete() },
      ]}
      role={incomplete() ? "alert" : "status"}
    >
      <span aria-hidden="true">
        <Icon name={incomplete() ? "alertTriangle" : "check"} />
      </span>
      <div>
        <strong>
          {t(incomplete() ? "memoryImport.importIncomplete" : "memoryImport.importComplete")}
        </strong>
        <span>
          {incomplete()
            ? t("memoryImport.importedWithIssues", {
                conflicts: String(props.result.summary.conflicts),
                errors: String(props.result.summary.errors),
                migrated: String(props.result.summary.migrated),
              })
            : t("memoryImport.importedCount", { count: String(props.result.summary.migrated) })}
        </span>
        <Show when={props.result.reportDir}>
          <span class="memory-import__result-path">
            {t("memoryImport.reportSaved")}:{" "}
            <code title={props.result.reportDir}>{props.result.reportDir}</code>
          </span>
        </Show>
        <Show when={details().length > 0}>
          <ul class="memory-import__result-issues">
            <For each={details()} keyed={(item) => item.id}>
              {(item) => (
                <li>
                  <strong>{artifactLabel(item())}</strong>
                  <span>
                    {formatUiExternalText(item().reason ?? item().message, item().status)}
                  </span>
                  <For
                    each={
                      [
                        ["memoryImport.recoveryFile", "recoveryPath"],
                        ["memoryImport.recoveryJournal", "recoveryRecordPath"],
                        ["memoryImport.itemBackup", "backupPath"],
                      ] as const
                    }
                  >
                    {(pair) => (
                      <Show when={detailString(item(), pair[1])}>
                        {(path) => (
                          <span class="memory-import__result-artifact">
                            <span>{t(pair[0])}</span>
                            <code title={path()}>{path()}</code>
                          </span>
                        )}
                      </Show>
                    )}
                  </For>
                </li>
              )}
            </For>
          </ul>
        </Show>
      </div>
    </div>
  );
}

function Provider(props: { view: MemoryImportViewProps; provider: MemoryMigrationProviderPlan }) {
  const selectedIds = createMemo(
    () => new Set(props.view.selectedByProvider[props.provider.providerId] ?? []),
  );
  const groups = createMemo(() => groupMemoryItems(props.provider.items));
  const disabled = () =>
    props.view.loading ||
    props.view.applyingProviderId !== null ||
    props.view.error !== null ||
    props.view.backfillBusy === "apply" ||
    props.view.backfillBusy === "rollback" ||
    props.view.backfillRollbackPending;
  return (
    <div data-provider-id={props.provider.providerId}>
      <SettingsSection
        title={
          <span class="memory-import__provider-title">
            <ProviderBrandIcon
              provider={props.provider.providerId}
              class="memory-import__provider-icon"
            />
            {providerLabel(props.provider)}
          </span>
        }
        description={t(
          props.provider.providerId === "codex"
            ? "memoryImport.codexDescription"
            : props.provider.providerId === "claude"
              ? "memoryImport.claudeDescription"
              : "memoryImport.providerFallback",
        )}
        actions={
          <SettingsStatus
            kind={props.provider.found ? "ok" : "muted"}
            label={
              props.provider.found
                ? countLabel("fileCount", props.provider.items.length)
                : t("memoryImport.notFound")
            }
          />
        }
      >
        <Show
          when={!props.provider.error}
          fallback={
            <div class="callout danger" role="alert">
              {formatUiExternalText(props.provider.error)}
            </div>
          }
        >
          <Show
            when={props.provider.found}
            fallback={
              <SettingsEmpty message={props.provider.message ?? t("memoryImport.noMemoryFound")} />
            }
          >
            <Show when={props.provider.source}>
              <SettingsRow
                title={t("memoryImport.source")}
                control={<SettingsValue value={props.provider.source} mono />}
              />
            </Show>
            <Show when={props.provider.target}>
              <SettingsRow
                title={t("memoryImport.destination")}
                control={<SettingsValue value={`${props.provider.target}/memory/imports/`} mono />}
              />
            </Show>
            <For each={groups()}>
              {(group) => (
                <Collection
                  provider={props.provider}
                  collection={group}
                  selectedIds={selectedIds()}
                  onToggle={props.view.onToggleCollection}
                  disabled={disabled()}
                />
              )}
            </For>
            <SettingsRow
              title={
                selectedIds().size > 0
                  ? t("memoryImport.selectedCount", { count: String(selectedIds().size) })
                  : t("memoryImport.selectAtLeastOne")
              }
              control={
                <button
                  class="btn primary"
                  data-test-id="memory-import-provider-button"
                  disabled={selectedIds().size === 0 || disabled()}
                  onClick={() => props.view.onRequestImport(props.provider.providerId)}
                >
                  {props.view.applyingProviderId === props.provider.providerId
                    ? t("common.importing")
                    : t("memoryImport.importSelected")}
                </button>
              }
            />
          </Show>
        </Show>
        <Show when={props.view.lastResults[props.provider.providerId]}>
          {(result) => <Result result={result()} />}
        </Show>
      </SettingsSection>
    </div>
  );
}

function Confirmation(props: { view: MemoryImportViewProps; backfill?: boolean }) {
  const provider = () =>
    props.backfill
      ? undefined
      : props.view.plan?.providers.find(
          (candidate) => candidate.providerId === props.view.pendingProviderId,
        );
  const title = () =>
    provider()
      ? t("memoryImport.confirmTitle", { provider: providerLabel(provider()!) })
      : t("memoryImport.backfill.rollbackConfirmTitle");
  const description = () =>
    provider()
      ? t("memoryImport.confirmDescription", {
          count: String(props.view.selectedByProvider[provider()!.providerId]?.length ?? 0),
        })
      : t("memoryImport.backfill.rollbackConfirmDescription");
  const busy = () =>
    props.view.applyingProviderId !== null || (props.backfill && props.view.backfillBusy !== null);
  const cancel = () => {
    if (props.backfill) {
      props.view.onBackfillRollbackCancel();
    } else if (props.view.applyingProviderId === null) {
      props.view.onCancelImport();
    }
  };
  return (
    <Show when={props.backfill ? props.view.backfillRollbackPending : provider()}>
      <openclaw-modal-dialog label={title()} description={description()} onModal-cancel={cancel}>
        <div class="exec-approval-card memory-import__confirm">
          <div class="exec-approval-header">
            <div>
              <div class="exec-approval-title">{title()}</div>
              <div class="exec-approval-sub">{description()}</div>
            </div>
          </div>
          <div class={["callout", { warn: props.backfill || props.view.replaceExisting }]}>
            {t(
              props.backfill
                ? "memoryImport.backfill.rollbackWarning"
                : props.view.replaceExisting
                  ? "memoryImport.confirmReplace"
                  : "memoryImport.confirmBackup",
            )}
          </div>
          <div class="exec-approval-actions">
            <button
              class={["btn", { danger: props.backfill, primary: !props.backfill }]}
              data-test-id={
                props.backfill ? "memory-backfill-rollback-confirm" : "memory-import-confirm"
              }
              disabled={busy()}
              onClick={() =>
                props.backfill
                  ? props.view.onBackfillRollbackConfirm()
                  : props.view.onConfirmImport()
              }
            >
              {t(props.backfill ? "memoryImport.backfill.rollback" : "memoryImport.confirmImport")}
            </button>
            <button class="btn" disabled={busy()} onClick={cancel}>
              {t("common.cancel")}
            </button>
          </div>
        </div>
      </openclaw-modal-dialog>
    </Show>
  );
}

function IntroSection(props: { view: MemoryImportViewProps }) {
  const busy = () =>
    props.view.loading ||
    props.view.applyingProviderId !== null ||
    props.view.backfillBusy !== null;
  return (
    <SettingsSection
      title={t("memoryImport.title")}
      description={t("memoryImport.subtitle")}
      actions={
        <button class="btn btn--sm" disabled={busy()} onClick={props.view.onRefresh}>
          {t(props.view.loading ? "common.refreshing" : "common.refresh")}
        </button>
      }
    >
      <Show when={props.view.agents.length > 1}>
        <SettingsRow
          title={t("memoryImport.agent")}
          control={
            <openclaw-agent-select
              class="agent-select--settings"
              name="memory-import-agent"
              prop:options={props.view.agents.map((agent) => ({
                value: agent.id,
                label: normalizeAgentLabel(agent),
                agent,
              }))}
              prop:value={props.view.selectedAgentId ?? ""}
              prop:accessibleLabel={t("memoryImport.agent")}
              prop:disabled={busy()}
              prop:onSelect={props.view.onSelectAgent}
            />
          }
        />
      </Show>
      <SettingsToggleRow
        title={t("memoryImport.replaceExisting")}
        description={t("memoryImport.replaceHint")}
        checked={props.view.replaceExisting}
        disabled={busy()}
        onChange={props.view.onReplaceExisting}
      />
    </SettingsSection>
  );
}

function BackfillSection(props: { view: MemoryImportViewProps }) {
  const busy = () => props.view.backfillBusy !== null || props.view.applyingProviderId !== null;
  return (
    <div data-test-id="memory-session-backfill">
      <SettingsSection
        title={t("memoryImport.backfill.title")}
        description={t("memoryImport.backfill.subtitle")}
      >
        <Show
          when={props.view.backfillAvailable}
          fallback={<SettingsEmpty message={t("memoryImport.backfill.unavailable")} />}
        >
          <SettingsRow
            title={t("memoryImport.backfill.dateRange")}
            description={t("memoryImport.backfill.dateRangeHint")}
            control={
              <div class="memory-import__backfill-dates">
                <label>
                  <span>{t("memoryImport.backfill.from")}</span>
                  <input
                    class="input"
                    type="date"
                    value={props.view.backfillFrom}
                    disabled={busy()}
                    onInput={(event) => props.view.onBackfillFromChange(event.currentTarget.value)}
                  />
                </label>
                <label>
                  <span>{t("memoryImport.backfill.to")}</span>
                  <input
                    class="input"
                    type="date"
                    value={props.view.backfillTo}
                    disabled={busy()}
                    onInput={(event) => props.view.onBackfillToChange(event.currentTarget.value)}
                  />
                </label>
              </div>
            }
          />
          <SettingsRow
            title={t("memoryImport.backfill.actions")}
            control={
              <div class="memory-import__backfill-actions">
                <button
                  class="btn"
                  data-test-id="memory-backfill-preview"
                  disabled={busy()}
                  onClick={props.view.onBackfillPreview}
                >
                  {t(
                    props.view.backfillBusy === "preview"
                      ? "memoryImport.backfill.previewing"
                      : "memoryImport.backfill.preview",
                  )}
                </button>
                <button
                  class="btn primary"
                  data-test-id="memory-backfill-apply"
                  disabled={busy()}
                  onClick={props.view.onBackfillApply}
                >
                  {t(
                    props.view.backfillBusy === "apply"
                      ? "memoryImport.backfill.applying"
                      : "memoryImport.backfill.apply",
                  )}
                </button>
                <button
                  class="btn danger"
                  data-test-id="memory-backfill-rollback"
                  disabled={busy()}
                  onClick={props.view.onBackfillRollbackRequest}
                >
                  {t("memoryImport.backfill.rollback")}
                </button>
              </div>
            }
          />
          <Show when={props.view.backfillError}>
            <div class="callout danger" role="alert">
              {props.view.backfillError}
            </div>
          </Show>
          <Show when={props.view.backfillPreview}>
            {(result) => (
              <div class="settings-row settings-row--stacked memory-import__backfill-preview">
                <strong role="status">
                  {t("memoryImport.backfill.previewSummary", {
                    candidates: String(result().candidates),
                    days: String(result().days),
                  })}
                </strong>
                <Show
                  when={result().perDay.length > 0}
                  fallback={<span>{t("memoryImport.backfill.noCandidates")}</span>}
                >
                  <ul>
                    <For each={result().perDay} keyed={(day) => day.day}>
                      {(day) => (
                        <li>
                          <div>
                            <strong>{day().day}</strong>
                            <span>
                              {t("memoryImport.backfill.candidateCount", {
                                count: String(day().candidateCount),
                              })}
                            </span>
                          </div>
                          <Show when={day().sample.length > 0}>
                            <ul>
                              <For each={day().sample}>{(sample) => <li>{sample}</li>}</For>
                            </ul>
                          </Show>
                        </li>
                      )}
                    </For>
                  </ul>
                </Show>
                <Show when={result().truncated}>
                  <div class="callout warn">{t("memoryImport.backfill.previewTruncated")}</div>
                </Show>
              </div>
            )}
          </Show>
          <Show when={props.view.backfillProgress}>
            {(progress) => (
              <div
                class="settings-row settings-row--stacked memory-import__backfill-progress"
                role="status"
              >
                <strong>
                  {progress().complete
                    ? t("memoryImport.backfill.complete", { count: String(progress().staged) })
                    : t("memoryImport.backfill.progress", {
                        days: String(progress().days),
                        staged: String(progress().staged),
                      })}
                </strong>
                <span>
                  {t("memoryImport.backfill.processedCandidates", {
                    count: String(progress().candidates),
                  })}{" "}
                  · {countLabel("backfill.processedDayCount", progress().days)}
                </span>
              </div>
            )}
          </Show>
          <Show when={props.view.backfillRollbackResult}>
            {(rollback) => (
              <div class="settings-row settings-row--stacked" role="status">
                <strong>{t("memoryImport.backfill.rollbackComplete")}</strong>
                <span>
                  {t("memoryImport.backfill.rollbackCounts", {
                    diary: String(rollback().removedDiaryEntries),
                    staged: String(rollback().removedStagedEntries),
                  })}
                </span>
              </div>
            )}
          </Show>
        </Show>
      </SettingsSection>
      <Confirmation view={props.view} backfill />
    </div>
  );
}

export function MemoryImport(props: MemoryImportViewProps) {
  return (
    <Show
      when={props.connected}
      fallback={
        <SettingsPage>
          <SettingsEmpty message={t("memoryImport.disconnected")} />
        </SettingsPage>
      }
    >
      <Show
        when={props.canAdmin}
        fallback={
          <SettingsPage>
            <SettingsEmpty message={t("memoryImport.adminRequired")} />
          </SettingsPage>
        }
      >
        <div class="memory-import" data-test-id="memory-import-page">
          <SettingsPage>
            <IntroSection view={props} />
            <BackfillSection view={props} />
            <Show when={props.error}>
              <div class="callout danger" role="alert">
                {props.error}
              </div>
            </Show>
            <Show when={props.applyError}>
              <div class="callout danger" role="alert">
                {props.applyError}
              </div>
            </Show>
            <Show
              when={props.loading && !props.plan}
              fallback={
                <For each={props.plan?.providers ?? []} keyed={(provider) => provider.providerId}>
                  {(provider) => <Provider view={props} provider={provider()} />}
                </For>
              }
            >
              <div class="settings-group memory-import__loading" aria-busy="true">
                <div class="skeleton memory-import__skeleton" />
                <div class="skeleton memory-import__skeleton" />
              </div>
            </Show>
            <Confirmation view={props} />
          </SettingsPage>
        </div>
      </Show>
    </Show>
  );
}
