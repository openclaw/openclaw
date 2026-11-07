import { normalizeLowercaseStringOrEmpty } from "@openclaw/normalization-core/string-coerce";
import { createMemo, Errored, For, isPending, latest, lazy, Loading, Show } from "solid-js";
import type { SkillStatusEntry } from "../../api/types.ts";
import { Icon } from "../../components/solid/icon.tsx";
import { InlineAlert } from "../../components/solid/inline-alert.tsx";
import { RefreshButton } from "../../components/solid/refresh-button.tsx";
import { SettingsSelect } from "../../components/solid/settings-select.tsx";
import {
  SettingsEmpty,
  SettingsPage,
  SettingsStatus,
} from "../../components/solid/settings-ui.tsx";
import { registerSkillLibraryEnglish } from "../../i18n/locales/en-skill-library.ts";
import { registerSkillsBrowserEnglish } from "../../i18n/locales/en-skills-browser.ts";
import { formatUiError } from "../../lib/format-error.ts";
import { clampText } from "../../lib/format.ts";
import { t } from "../../lib/reactive/i18n.ts";
import { createProgressiveList } from "../../lib/reactive/progressive-list.ts";
import "../../styles/carapace-control-ui.css";
import "../../styles/plugins.css";
import { groupSkills, type SkillGroup } from "../../lib/skills-grouping.ts";
import { isSkillAvailable } from "../../lib/skills-shared.ts";
import { SkillDiscovery } from "./discovery-view.tsx";
import { SkillDialogBoundary } from "./skill-dialog-boundary.tsx";
import { SkillRowStatus, verdictForSkill, verdictStatus } from "./skill-status.tsx";
import type { SkillsProps, SkillsStatusFilter } from "./view-types.ts";

registerSkillsBrowserEnglish();
registerSkillLibraryEnglish();

const SkillDetail = lazy(() => import("./skill-detail.tsx"), { export: "SkillDetail" });
const ClawHubDetailDialog = lazy(() => import("./skill-reader-dialog.tsx"), {
  export: "ClawHubDetailDialog",
});

const STATUS_TABS: Array<{ id: SkillsStatusFilter; labelKey: string }> = [
  { id: "all", labelKey: "skillsPage.tabs.all" },
  { id: "ready", labelKey: "skillsPage.tabs.ready" },
  { id: "needs-setup", labelKey: "skillsPage.tabs.needsSetup" },
  { id: "disabled", labelKey: "skillsPage.tabs.disabled" },
];

function skillStatus(skill: SkillStatusEntry): Exclude<SkillsStatusFilter, "all"> {
  return skill.disabled ? "disabled" : isSkillAvailable(skill) ? "ready" : "needs-setup";
}

function skillControlsLocked(view: SkillsProps): boolean {
  return view.saving || view.loading || view.state.skillOperation !== null;
}

function skillInstallLocked(view: SkillsProps): boolean {
  return skillControlsLocked(view) || !view.canInstall;
}

export function Skills(props: SkillsProps) {
  const acceptedReport = createMemo(() => props.state.skillsReport);
  const completion = createMemo(() => props.state.skillsRead);
  const read = createMemo(() => {
    const receipt = completion();
    const value = acceptedReport();
    return receipt?.completion ?? Promise.resolve({ value, error: null });
  });
  // Toolbar counts and selection stay available outside the inventory's first-load boundary.
  const skills = createMemo(() => props.mutationSkills);
  const readError = () => {
    const outcome = latest(read);
    const error = outcome.error ?? props.error;
    if (!isPending(read) && error) {
      throw new Error(error);
    }
    return null;
  };
  const emptyMessage = () =>
    !props.state.connected && !props.state.skillsReport
      ? t("skillsPage.disconnected")
      : props.state.skillsFilter.trim()
        ? t("skillsPage.noMatches")
        : skills().length > 0
          ? t("skillsPage.noFilteredSkills")
          : t("skillsPage.empty");
  const statusCounts = createMemo(() => {
    const counts: Record<SkillsStatusFilter, number> = {
      all: skills().length,
      ready: 0,
      "needs-setup": 0,
      disabled: 0,
    };
    for (const skill of skills()) {
      counts[skillStatus(skill)]++;
    }
    return counts;
  });
  const filterSkills = (items: SkillStatusEntry[]) => {
    const afterStatus =
      props.state.skillsStatusFilter === "all"
        ? items
        : items.filter((skill) => skillStatus(skill) === props.state.skillsStatusFilter);
    const filter = normalizeLowercaseStringOrEmpty(props.state.skillsFilter).normalize("NFC");
    return filter
      ? afterStatus.filter((skill) =>
          normalizeLowercaseStringOrEmpty([skill.name, skill.description, skill.source].join(" "))
            .normalize("NFC")
            .includes(filter),
        )
      : afterStatus;
  };
  const acceptedFiltered = createMemo(() => filterSkills(skills()));
  const groups = createMemo(() => groupSkills(acceptedFiltered()));
  const detailSkill = createMemo(() =>
    props.state.skillsDetailKey
      ? (skills().find((skill) => skill.skillKey === props.state.skillsDetailKey) ?? null)
      : null,
  );
  return (
    <>
      <SettingsPage wide carapace={props.surface === "discovery"}>
        <Show
          when={props.surface === "discovery"}
          fallback={
            <>
              {props.library}
              <Show when={props.showInventory !== false}>
                <SkillsToolbar view={props} statusCounts={statusCounts()} readInventory={read} />
              </Show>
              <Errored
                fallback={(error) => (
                  <Loading>
                    <Show when={!isPending(read)}>
                      <InlineAlert tone="danger" role="alert">
                        {formatUiError(error())}
                      </InlineAlert>
                    </Show>
                  </Loading>
                )}
              >
                <Loading>{readError()}</Loading>
              </Errored>
              <Show when={props.showInventory !== false}>
                <Show
                  when={acceptedFiltered().length > 0}
                  fallback={<SettingsEmpty message={emptyMessage()} />}
                >
                  <SkillsInventory groups={groups()} view={props} />
                </Show>
              </Show>
            </>
          }
        >
          <SkillDiscovery {...props} />
          {props.library}
        </Show>
      </SettingsPage>
      <Show when={detailSkill()}>
        {(skill) => (
          <SkillDialogBoundary onClose={() => props.onDetailClose()}>
            <SkillDetail
              skill={skill()}
              view={props}
              controlsLocked={skillControlsLocked(props)}
              installLocked={skillInstallLocked(props)}
            />
          </SkillDialogBoundary>
        )}
      </Show>
      <Show when={props.state.clawhubDetailRef}>
        <SkillDialogBoundary onClose={() => props.onClawHubDetailClose()}>
          <ClawHubDetailDialog view={props} installLocked={skillInstallLocked(props)} />
        </SkillDialogBoundary>
      </Show>
    </>
  );
}

function SkillsInventory(props: { groups: SkillGroup[]; view: SkillsProps }) {
  const skills = createMemo(() => props.groups.flatMap((group) => group.skills));
  const visible = createProgressiveList(skills, { initial: 1, batch: 500 });
  const groups = createMemo(() => {
    let remaining = visible.items().length;
    // Reveal one grouped prefix so adding earlier rows never moves a later heading.
    return props.groups.flatMap((group) => {
      const count = Math.min(remaining, group.skills.length);
      remaining -= count;
      return count > 0
        ? [
            {
              group,
              skills: count === group.skills.length ? group.skills : group.skills.slice(0, count),
            },
          ]
        : [];
    });
  });
  return (
    <For each={groups()} keyed={(entry) => entry.group.id}>
      {(entry) => (
        <SkillGroupView
          group={entry().group}
          skills={entry().skills}
          busy={visible.pending()}
          view={props.view}
        />
      )}
    </For>
  );
}

function SkillGroupView(props: {
  group: SkillGroup;
  skills: SkillStatusEntry[];
  busy: boolean;
  view: SkillsProps;
}) {
  const skills = createMemo(() => props.skills);
  return (
    <details class="settings-section skills-group" aria-busy={props.busy ? "true" : "false"} open>
      <summary class="settings-section__header skills-group__summary">
        <h2 class="settings-section__heading">
          {props.group.label} <span class="settings-count">{props.group.skills.length}</span>
        </h2>
        <span class="skills-group__chevron" aria-hidden="true">
          <Icon name="chevronRight" />
        </span>
      </summary>
      <div class="settings-group">
        <For each={skills()} keyed={(skill) => skill.skillKey}>
          {(skill) => <SkillRow skill={skill()} view={props.view} />}
        </For>
      </div>
    </details>
  );
}

function SkillsToolbar(props: {
  view: SkillsProps;
  statusCounts: Record<SkillsStatusFilter, number>;
  readInventory: () => unknown;
}) {
  return (
    <div class="plugins-toolbar plugins-toolbar--fields">
      <label class="skills-toolbar__search">
        <span>{t("common.search")}</span>
        <input
          class="settings-input"
          value={props.view.state.skillsFilter}
          onInput={(event) => props.view.onFilterChange(event.currentTarget.value)}
          placeholder={t("skillsPage.filterPlaceholder")}
          autocomplete="off"
          name="skills-filter"
        />
      </label>
      <SettingsSelect
        class="skills-toolbar__status"
        value={props.view.state.skillsStatusFilter}
        aria-label={t("skillsPage.title")}
        options={STATUS_TABS.map((tab) => ({
          value: tab.id,
          label: `${t(tab.labelKey)} ${props.statusCounts[tab.id]}`,
        }))}
        onChange={(event) => {
          const next = STATUS_TABS.find((tab) => tab.id === event.currentTarget.value);
          if (next) {
            props.view.onStatusFilterChange(next.id);
          }
        }}
      />
      <Loading
        fallback={
          <RefreshButton label={t("common.refresh")} busy onClick={() => props.view.onRefresh()} />
        }
      >
        <RefreshButton
          label={t("common.refresh")}
          busy={isPending(props.readInventory) || props.view.loading}
          disabled={skillControlsLocked(props.view) || !props.view.state.connected}
          onClick={() => props.view.onRefresh()}
        />
      </Loading>
      {props.view.pageMenu?.()}
    </div>
  );
}

function SkillRow(props: { skill: SkillStatusEntry; view: SkillsProps }) {
  const verdict = createMemo(() => verdictForSkill(props.skill, props.view.state.clawhubVerdicts));
  const status = () => {
    latest(props.view.readClawHubVerdicts);
    return verdictStatus(verdict(), isPending(props.view.readClawHubVerdicts));
  };
  return (
    <div class="settings-row plugins-item plugins-item--clickable">
      <button
        type="button"
        class="settings-row__text plugins-item__detail-button"
        aria-label={t("skillsPage.openDetails", { name: props.skill.name })}
        onClick={() => props.view.onDetailOpen(props.skill.skillKey)}
      >
        <span class="settings-row__title">
          <Show when={props.skill.emoji}>
            {(emoji) => (
              <>
                <span>{emoji()}</span>{" "}
              </>
            )}
          </Show>
          {props.skill.name}
        </span>
        <span class="settings-row__desc">{clampText(props.skill.description, 140)}</span>
      </button>
      <div class="settings-row__control">
        <SkillRowStatus skill={props.skill} verdict={verdict()} />
        <Show
          when={props.skill.clawhub?.status === "linked"}
          fallback={
            <Show when={props.skill.clawhub?.status === "invalid"}>
              <SettingsStatus kind="warn" label={t("skillsPage.invalidLink")} />
            </Show>
          }
        >
          <Errored
            fallback={() => (
              <Loading fallback={<SettingsStatus {...verdictStatus(null, true)} />}>
                <SettingsStatus
                  {...verdictStatus(null, isPending(props.view.readClawHubVerdicts))}
                />
              </Loading>
            )}
          >
            <Loading fallback={<SettingsStatus {...verdictStatus(null, true)} />}>
              <SettingsStatus {...status()} />
            </Loading>
          </Errored>
        </Show>
      </div>
    </div>
  );
}
