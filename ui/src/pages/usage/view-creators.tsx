import { For, createMemo } from "solid-js";
import type {
  SessionUsageCreator,
  SessionsUsageAggregates,
} from "../../../../src/shared/usage-types.js";
import { SessionOwnerChip } from "../../components/solid/session-owner-chip.tsx";
import { SettingsSelect } from "../../components/solid/settings-select.tsx";
import { SettingsSection } from "../../components/solid/settings-ui.tsx";
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

/** Legacy channel identities carry only a raw sender id; the creator key names the channel. */
function channelCreatorLabel(key: string, id: string): string | undefined {
  let parts: unknown;
  try {
    parts = JSON.parse(key);
  } catch {
    return undefined;
  }
  if (!Array.isArray(parts) || parts[1] !== "channel" || typeof parts[3] !== "string") {
    return undefined;
  }
  const channel = parts[3];
  const name = channel.charAt(0).toUpperCase() + channel.slice(1);
  const local = id.startsWith(`${channel}:`) ? id.slice(channel.length + 1) : id;
  const topic = /^group:[^:]+:topic:(.+)$/.exec(local);
  if (topic) {
    return t("usage.creators.channelTopic", { channel: name, topic: topic[1]! });
  }
  return local.startsWith("group:")
    ? t("usage.creators.channelGroup", { channel: name })
    : t("usage.creators.channelUser", { channel: name, id: local });
}

function creatorLabel({ key, actor }: SessionUsageCreator): string {
  if (!actor) {
    return t("usage.creators.unattributed");
  }
  const name =
    actor.label?.trim() ||
    (actor.identity?.type === "legacy" && actor.id
      ? channelCreatorLabel(key, actor.id)
      : undefined) ||
    actor.identity?.id ||
    actor.id ||
    t(actor.type === "system" ? "usage.creators.system" : "usage.common.unknown");
  return actor.identity?.type === "profile"
    ? presenceViewerLabel({ id: actor.identity.id, name: actor.label?.trim() || undefined })
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
      .map((creator) => ({ value: creator.key, label: creatorLabel(creator) }));
    // Keep the active filter explicit when this range has no creator metadata.
    if (
      props.selectedKey !== null &&
      !entries.some((option) => option.value === props.selectedKey)
    ) {
      entries.push({ value: props.selectedKey, label: t("usage.creators.selected") });
    }

    return [{ value: "", label: t("usage.creators.all") }, ...entries];
  });
  return (
    <SettingsSelect
      class="usage-select usage-creator-filter"
      aria-label={t("usage.creators.select")}
      value={props.selectedKey ?? ""}
      options={options()}
      onChange={(event) => props.onSelect(event.currentTarget.value || null)}
    />
  );
}

export function UsageCreators(props: UsageCreatorsProps) {
  const value = (group: UsageCreatorGroup, mode: UsageCreatorsProps["mode"]) =>
    mode === "tokens" ? group.totals.totalTokens : group.totals.totalCost;
  const groups = createMemo(() => {
    const mode = props.mode;
    // Sessions without a recorded creator sort last: they are a gap in the data, not a person.
    return props.groups.toSorted(
      (a, b) =>
        Number(!a.actor) - Number(!b.actor) ||
        value(b, mode) - value(a, mode) ||
        creatorLabel(a).localeCompare(creatorLabel(b)),
    );
  });
  const total = createMemo(() => {
    const mode = props.mode;
    return groups().reduce((sum, group) => sum + value(group, mode), 0);
  });
  const CreatorTable = (tableProps: { rows: readonly UsageCreatorGroup[] }) => (
    <table class="usage-creators-table">
      <thead>
        <tr>
          <th scope="col">{t("usage.creators.identity")}</th>
          <th scope="col">{t("usage.metrics.tokens")}</th>
          <th scope="col">{t("usage.metrics.cost")}</th>
          <th scope="col">{t("usage.overview.sessions")}</th>
        </tr>
      </thead>
      <tbody>
        <For each={tableProps.rows} keyed={(group) => group.key}>
          {(group) => (
            <tr
              class={{
                selected: group().key === props.selectedKey,
                "usage-creator-row--unrecorded": !group().actor,
              }}
              title={group().actor ? undefined : t("usage.creators.unattributedHint")}
            >
              <th scope="row">
                <button
                  type="button"
                  class="usage-creator-select"
                  aria-pressed={group().key === props.selectedKey ? "true" : "false"}
                  onClick={() => props.onSelect(group().key)}
                >
                  <span class="usage-creator-name">
                    <span aria-hidden="true">
                      {group().actor?.id ? (
                        <SessionOwnerChip owner={group().actor} size="row" />
                      ) : undefined}
                    </span>
                    <span>{creatorLabel(group())}</span>
                  </span>
                  <span class="usage-creator-track" aria-hidden="true">
                    <span
                      style={{
                        width: `${total() > 0 ? (value(group(), props.mode) / total()) * 100 : 0}%`,
                      }}
                    />
                  </span>
                </button>
              </th>
              <td class={{ "usage-creator-primary": props.mode === "tokens" }}>
                {formatUsageTokens(group().totals.totalTokens)}
              </td>
              <td class={{ "usage-creator-primary": props.mode === "cost" }}>
                {formatUsageCost(group().totals.totalCost)}
              </td>
              <td>{group().sessionCount}</td>
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
          <CreatorTable rows={groups().slice(0, 8)} />
        ) : (
          <div class="usage-empty-block usage-empty-block--compact">
            {t("usage.creators.empty")}
          </div>
        )}
        {groups().length > 8 ? (
          <details class="usage-creators-more">
            <summary>{t("usage.creators.more", { count: String(groups().length - 8) })}</summary>
            <CreatorTable rows={groups().slice(8)} />
          </details>
        ) : undefined}
      </div>
    </SettingsSection>
  );
}
