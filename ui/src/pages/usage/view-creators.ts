import { html, nothing } from "lit";
import type {
  SessionUsageCreator,
  SessionsUsageAggregates,
} from "../../../../src/shared/usage-types.js";
import { renderSessionOwnerChip } from "../../components/session-owner-chip.ts";
import { renderSettingsSection } from "../../components/settings-ui.ts";
import { t } from "../../i18n/index.ts";
import { presenceViewerLabel } from "../../lib/presence-users.ts";
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

export function renderUsageCreatorFilter(props: {
  options: readonly SessionUsageCreator[];
  selectedKey: string | null;
  onSelect: (key: string | null) => void;
}) {
  const options = props.options
    .toSorted((a, b) => creatorLabel(a).localeCompare(creatorLabel(b)))
    .map((creator) => ({ key: creator.key, label: creatorLabel(creator) }));
  // Keep the active filter explicit when this range has no creator metadata.
  if (props.selectedKey !== null && !options.some((option) => option.key === props.selectedKey)) {
    options.push({ key: props.selectedKey, label: t("usage.creators.selected") });
  }
  return html`
    <select
      class="usage-select usage-creator-filter"
      aria-label=${t("usage.creators.select")}
      @change=${(event: Event) => {
        // SAFETY: This listener is attached directly to the identity select.
        const key = (event.currentTarget as HTMLSelectElement).value;
        props.onSelect(key || null);
      }}
    >
      <option value="" .selected=${props.selectedKey === null}>${t("usage.creators.all")}</option>
      ${options.map(
        (creator) => html`
          <option value=${creator.key} .selected=${creator.key === props.selectedKey}>
            ${creator.label}
          </option>
        `,
      )}
    </select>
  `;
}

export function renderUsageCreators(props: UsageCreatorsProps) {
  const value = (group: UsageCreatorGroup) =>
    props.mode === "tokens" ? group.totals.totalTokens : group.totals.totalCost;
  const groups = props.groups.toSorted(
    (a, b) => value(b) - value(a) || creatorLabel(a).localeCompare(creatorLabel(b)),
  );
  const total = groups.reduce((sum, group) => sum + value(group), 0);
  const renderRows = (rows: readonly UsageCreatorGroup[]) => html`
    <table class="usage-creators-table">
      <thead>
        <tr>
          <th scope="col">${t("usage.creators.identity")}</th>
          <th scope="col">${t("usage.metrics.tokens")}</th>
          <th scope="col">${t("usage.metrics.cost")}</th>
          <th scope="col">${t("usage.metrics.sessions")}</th>
        </tr>
      </thead>
      <tbody>
        ${rows.map(
          (group) => html`
            <tr class=${group.key === props.selectedKey ? "selected" : ""}>
              <th scope="row">
                <button
                  type="button"
                  class="usage-creator-select"
                  aria-pressed=${group.key === props.selectedKey}
                  @click=${() => props.onSelect(group.key)}
                >
                  <span class="usage-creator-name">
                    <span aria-hidden="true">${renderSessionOwnerChip(group.actor, "row")}</span>
                    <span>${creatorLabel(group)}</span>
                  </span>
                  <span class="usage-creator-track" aria-hidden="true">
                    <span style=${`width: ${total > 0 ? (value(group) / total) * 100 : 0}%`}></span>
                  </span>
                </button>
              </th>
              <td class=${props.mode === "tokens" ? "usage-creator-primary" : ""}>
                ${formatUsageTokens(group.totals.totalTokens)}
              </td>
              <td class=${props.mode === "cost" ? "usage-creator-primary" : ""}>
                ${formatUsageCost(group.totals.totalCost)}
              </td>
              <td>${group.sessionCount}</td>
            </tr>
          `,
        )}
      </tbody>
    </table>
  `;

  return renderSettingsSection(
    {
      title: t("usage.creators.title"),
      description: t("usage.creators.description"),
    },
    html`
      <div class="usage-panel usage-creators">
        ${
          groups.length > 0
            ? renderRows(groups.slice(0, 8))
            : html`<div class="usage-empty-block usage-empty-block--compact">
                ${t("usage.creators.empty")}
              </div>`
        }
        ${
          groups.length > 8
            ? html`
                <details class="usage-creators-more">
                  <summary>
                    ${t("usage.creators.more", { count: String(groups.length - 8) })}
                  </summary>
                  ${renderRows(groups.slice(8))}
                </details>
              `
            : nothing
        }
      </div>
    `,
  );
}
