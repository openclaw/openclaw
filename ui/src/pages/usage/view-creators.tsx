import { For, createMemo } from "solid-js";
import type {
  SessionUsageCreator,
  SessionsUsageAggregates,
} from "../../../../src/shared/usage-types.js";
import { SettingsSection } from "../../components/solid/settings-ui.tsx";
import "../../components/session-owner-chip.ts";
import { presenceViewerLabel } from "../../lib/presence-users.ts";
import { t } from "../../lib/reactive/i18n.ts";
import { formatUsageCost, formatUsageTokens } from "./metrics.ts";

type UsageCreatorGroup = NonNullable<SessionsUsageAggregates["byCreator"]>[number];

type UsageCreatorsProps = {
  groups: readonly UsageCreatorGroup[];
  selectedKey: string | null;
  mode: "tokens" | "cost";
  onSelect: (key: string | null) => void;
};

function creatorLabel({ actor }: SessionUsageCreator): string {
  if (!actor) {
    return t("usage.creators.unattributed");
  }
  const name =
    actor.label?.trim() ||
    actor.identity?.id ||
    actor.id ||
    t(actor.type === "system" ? "usage.creators.system" : "usage.common.unknown");
  return actor.identity?.type === "profile"
    ? presenceViewerLabel({ id: actor.identity.id, name })
    : name;
}

export function UsageCreatorFilter(props: {
  options: readonly SessionUsageCreator[];
  selectedKey: string | null;
  onSelect: (key: string | null) => void;
}) {
  const options = createMemo(() => {
    const entries = props.options
      .toSorted((a, b) => creatorLabel(a).localeCompare(creatorLabel(b)))
      .map((creator) => ({ key: creator.key, label: creatorLabel(creator) }));
    // Keep the active filter explicit when this range has no creator metadata.
    if (props.selectedKey !== null && !entries.some((option) => option.key === props.selectedKey)) {
      entries.push({ key: props.selectedKey, label: t("usage.creators.selected") });
    }

    return entries;
  });
  return (
    <select
      class="usage-select usage-creator-filter"
      aria-label={t("usage.creators.select")}
      onChange={(event: Event) => {
        // SAFETY: This listener is attached directly to the identity select.
        const key = (event.currentTarget as HTMLSelectElement).value;
        props.onSelect(key || null);
      }}
    >
      <option value="" selected={props.selectedKey === null}>
        {t("usage.creators.all")}
      </option>
      <For each={options()}>
        {(creator) => (
          <option value={creator.key} selected={creator.key === props.selectedKey}>
            {creator.label}
          </option>
        )}
      </For>
    </select>
  );
}

export function UsageCreators(props: UsageCreatorsProps) {
  const value = (group: UsageCreatorGroup, mode: UsageCreatorsProps["mode"]) =>
    mode === "tokens" ? group.totals.totalTokens : group.totals.totalCost;
  const groups = createMemo(() => {
    const mode = props.mode;
    return props.groups.toSorted(
      (a, b) => value(b, mode) - value(a, mode) || creatorLabel(a).localeCompare(creatorLabel(b)),
    );
  });
  const total = createMemo(() => {
    const mode = props.mode;
    return groups().reduce((sum, group) => sum + value(group, mode), 0);
  });
  const renderRows = (rows: readonly UsageCreatorGroup[]) => (
    <table class="usage-creators-table">
      <thead>
        <tr>
          <th scope="col">{t("usage.creators.identity")}</th>
          <th scope="col">{t("usage.metrics.tokens")}</th>
          <th scope="col">{t("usage.metrics.cost")}</th>
          <th scope="col">{t("usage.metrics.sessions")}</th>
        </tr>
      </thead>
      <tbody>
        <For each={rows}>
          {(group) => (
            <tr class={group.key === props.selectedKey ? "selected" : ""}>
              <th scope="row">
                <button
                  type="button"
                  class="usage-creator-select"
                  aria-pressed={group.key === props.selectedKey ? "true" : "false"}
                  onClick={() => props.onSelect(group.key)}
                >
                  <span class="usage-creator-name">
                    <span aria-hidden="true">
                      {group.actor?.id ? (
                        <openclaw-session-owner-chip prop:owner={group.actor} size="row" />
                      ) : undefined}
                    </span>
                    <span>{creatorLabel(group)}</span>
                  </span>
                  <span class="usage-creator-track" aria-hidden="true">
                    <span
                      style={{
                        width: `${total() > 0 ? (value(group, props.mode) / total()) * 100 : 0}%`,
                      }}
                    />
                  </span>
                </button>
              </th>
              <td class={props.mode === "tokens" ? "usage-creator-primary" : ""}>
                {formatUsageTokens(group.totals.totalTokens)}
              </td>
              <td class={props.mode === "cost" ? "usage-creator-primary" : ""}>
                {formatUsageCost(group.totals.totalCost)}
              </td>
              <td>{group.sessionCount}</td>
            </tr>
          )}
        </For>
      </tbody>
    </table>
  );

  return (
    <SettingsSection
      title={t("usage.creators.title")}
      description={t("usage.creators.description")}
    >
      <div class="usage-panel usage-creators">
        {groups().length > 0 ? (
          renderRows(groups().slice(0, 8))
        ) : (
          <div class="usage-empty-block usage-empty-block--compact">
            {t("usage.creators.empty")}
          </div>
        )}
        {groups().length > 8 ? (
          <details class="usage-creators-more">
            <summary>{t("usage.creators.more", { count: String(groups().length - 8) })}</summary>
            {renderRows(groups().slice(8))}
          </details>
        ) : undefined}
      </div>
    </SettingsSection>
  );
}
