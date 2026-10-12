import type {
  SkillsWorkshopListResult,
  SkillWorkshopChange,
  SkillWorkshopSkillSummary,
} from "@openclaw/gateway-protocol";
import { createMemo, For, Show } from "solid-js";
import { renderAgentScopeControl } from "../../components/agent-scope-control.ts";
import { Icon } from "../../components/solid/icon.tsx";
import {
  SettingsEmpty,
  SettingsLoadingSkeleton,
  SettingsPage,
  SettingsSegmented,
} from "../../components/solid/settings-ui.tsx";
import { SettingsWorkspace } from "../../components/solid/settings-workspace.tsx";
import { registerSkillWorkshopEnglish } from "../../i18n/locales/en-skill-workshop.ts";
import { formatRelativeTimestamp } from "../../lib/format.ts";
import { registerEnglishCatalog, t } from "../../lib/reactive/i18n.ts";
import { LitContent } from "../../lit/solid-bridge.ts";
import "../../styles/chat/text.css";
import "../../styles/plugins.css";
import "../../styles/skill-workshop.css";
import { PluginsHubHeader } from "../plugins/plugins-hub-header.tsx";
import { PLUGINS_HUB_PANEL_ID } from "../plugins/plugins-hub.ts";
import { undoMutationFor } from "./api.ts";
import { Detail } from "./detail.tsx";
import type { SkillWorkshopMode } from "./mode.ts";
import {
  lastActivityMs,
  latestChanges,
  MutationButton,
  renderUses,
  WorkshopChangeText,
  UNUSED_ARCHIVE_DAYS,
  unusedDays,
  type WorkshopSort,
  type WorkshopView,
} from "./view-shared.tsx";
export type {
  WorkshopFilter,
  WorkshopSort,
  WorkshopTab,
  WorkshopViewer,
  WorkshopViewerTarget,
} from "./view-shared.tsx";

registerEnglishCatalog(registerSkillWorkshopEnglish);
const MODES: readonly SkillWorkshopMode[] = ["off", "auto"];
const SORTS: readonly WorkshopSort[] = ["uses", "recent", "name"];
export function sortWorkshopSkills(
  skills: readonly SkillWorkshopSkillSummary[],
  changes: readonly SkillWorkshopChange[],
  sort: WorkshopSort,
): SkillWorkshopSkillSummary[] {
  const latest = latestChanges(changes);
  const recent = (skill: SkillWorkshopSkillSummary) =>
    lastActivityMs(skill, latest.get(skill.name));
  return skills.toSorted((a, b) =>
    sort === "name"
      ? a.name.localeCompare(b.name)
      : sort === "recent"
        ? recent(b) - recent(a)
        : (b.useCount ?? 0) - (a.useCount ?? 0) ||
          recent(b) - recent(a) ||
          a.name.localeCompare(b.name),
  );
}
export function archivedWorkshopSkills(list: SkillsWorkshopListResult) {
  return list.archived
    .filter((skill) => !skill.live && skill.versions.length > 0)
    .toSorted((a, b) => (b.versions[0]?.createdAtMs ?? 0) - (a.versions[0]?.createdAtMs ?? 0));
}

export function SkillWorkshopView(props: { view: WorkshopView }) {
  return (
    <>
      <PluginsHubHeader
        active="skill-workshop"
        onSelect={(tab) => props.view().context.navigate(tab)}
      />
      <SettingsWorkspace>
        <wa-tab-panel
          id={PLUGINS_HUB_PANEL_ID}
          name="skill-workshop"
          prop:active={true}
          aria-labelledby="plugins-tab-skill-workshop"
        >
          <SettingsPage wide carapace>
            <Toolbar view={props.view} />
            <For
              each={[
                props.view().learningError,
                props.view().modeError,
                props.view().actionError,
              ].filter(Boolean)}
            >
              {(message) => <ErrorBanner message={message ?? ""} />}
            </For>
            {props.view().error && (
              <ErrorBanner
                message={`${t("skillWorkshop.loadError")} ${props.view().error}`}
                onRetry={props.view().onRetry}
              />
            )}
            <Show
              when={props.view().snapshot}
              fallback={props.view().loading && <SettingsLoadingSkeleton carapace />}
            >
              <Library view={props.view} />
            </Show>
          </SettingsPage>
        </wa-tab-panel>
      </SettingsWorkspace>
    </>
  );
}

function ErrorBanner(props: { message: string; onRetry?: () => void }) {
  return (
    <div class="callout danger oc-banner oc-banner-error" role="alert">
      <span>{props.message}</span>
      {props.onRetry && (
        <button
          type="button"
          class="btn btn--sm oc-action oc-action-secondary oc-banner-action"
          onClick={() => props.onRetry?.()}
        >
          {t("skillWorkshop.retry")}
        </button>
      )}
    </div>
  );
}

function Toolbar(props: { view: WorkshopView }) {
  const learningTitle = () => {
    const access = props.view().learningAccess;
    return access.allowed ? t("skillWorkshop.learning.description") : access.reason;
  };
  return (
    <div class="sw-toolbar">
      <div class="sw-toolbar__start">
        <LitContent
          render={() =>
            renderAgentScopeControl({
              agents: props.view().context.agents.state.agentsList?.agents ?? [],
              selection: props.view().context.agentSelection,
              selectedId: props.view().agentId,
              allowAll: false,
            })
          }
        />
      </div>
      <div class="sw-toolbar__end">
        <Show when={props.view().mode}>
          {(mode) => (
            <div class="sw-learning" title={t(`skillWorkshop.mode.${mode()}Title`)}>
              <span class="sw-learning__label">
                <span
                  class={["sw-learning__dot", `sw-learning__dot--${mode()}`]}
                  aria-hidden="true"
                />
                {t("skillWorkshop.mode.label")}
              </span>
              <SettingsSegmented
                mode="buttons"
                ariaLabel={t("skillWorkshop.mode.aria")}
                value={mode()}
                disabled={props.view().modeBusy || !props.view().access.canSetMode}
                options={MODES.map((value) => ({ value, label: t(`skillWorkshop.mode.${value}`) }))}
                onChange={(nextMode) => props.view().onModeChange(nextMode)}
              />
            </div>
          )}
        </Show>
        <button
          type="button"
          class="btn btn--sm oc-action"
          title={learningTitle()}
          disabled={props.view().learningBusy || !props.view().learningAccess.allowed}
          onClick={() => props.view().onLearn()}
        >
          <span aria-hidden="true">
            <Icon name="wandSparkles" />
          </span>
          {props.view().learningBusy
            ? t("skillWorkshop.learning.starting")
            : t("skillWorkshop.learning.short")}
        </button>
      </div>
    </div>
  );
}

type SkillRowEntry = SkillWorkshopSkillSummary | SkillsWorkshopListResult["archived"][number];
function Library(props: { view: WorkshopView }) {
  const list = () => props.view().snapshot!.list;
  const archived = createMemo(() => archivedWorkshopSkills(list()));
  const rows = createMemo<SkillRowEntry[]>(() =>
    props.view().filter === "active"
      ? sortWorkshopSkills(list().skills, props.view().snapshot!.changes, props.view().sort)
      : archived(),
  );
  return (
    <Show
      when={list().skills.length > 0 || archived().length > 0}
      fallback={
        <div class="sw-empty oc-settings-group settings-group">
          <span class="sw-empty__icon" aria-hidden="true">
            <Icon name="wandSparkles" />
          </span>
          <p>{t("skillWorkshop.skills.empty")}</p>
        </div>
      }
    >
      <div class="sw-layout">
        <section
          class="sw-list settings-group oc-settings-group"
          aria-label={t("skillWorkshop.skills.title")}
        >
          <div class="sw-list__head">
            <SettingsSegmented
              mode="buttons"
              ariaLabel={t("skillWorkshop.skills.filterAria")}
              value={props.view().filter}
              options={(["active", "archived"] as const).map((value) => ({
                value,
                label: (
                  <>
                    {t(`skillWorkshop.skills.${value}`)}{" "}
                    <span class="settings-count">
                      {value === "active" ? list().skills.length : archived().length}
                    </span>
                  </>
                ),
              }))}
              onChange={(filter) => props.view().onFilter(filter)}
            />
            {props.view().filter === "active" && (
              <label class="sw-sort">
                <span class="sr-only">{t("skillWorkshop.sort.label")}</span>
                <select
                  class="settings-select"
                  aria-label={t("skillWorkshop.sort.label")}
                  value={props.view().sort}
                  onChange={(event) => {
                    const sort = SORTS.find((entry) => entry === event.currentTarget.value);
                    if (sort) {
                      props.view().onSort(sort);
                    }
                  }}
                >
                  <For each={SORTS}>
                    {(sort) => <option value={sort}>{t(`skillWorkshop.sort.${sort}`)}</option>}
                  </For>
                </select>
              </label>
            )}
          </div>
          <div class="sw-list__rows">
            <For
              each={rows()}
              keyed={(skill) => skill.name}
              fallback={
                <SettingsEmpty
                  message={t(
                    props.view().filter === "active"
                      ? "skillWorkshop.skills.noneActive"
                      : "skillWorkshop.skills.noneArchived",
                  )}
                  carapace
                />
              }
            >
              {(skill) => <SkillRow skill={skill()} view={props.view} />}
            </For>
          </div>
        </section>
        <section class="sw-detail settings-group oc-settings-group">
          <Show
            when={props.view().viewer}
            fallback={<SettingsEmpty message={t("skillWorkshop.viewer.pick")} carapace />}
          >
            <Detail view={props.view} />
          </Show>
        </section>
      </div>
    </Show>
  );
}

function SkillRow(props: { skill: SkillRowEntry; view: WorkshopView }) {
  const live = () => ("versions" in props.skill ? null : props.skill);
  const archived = () => ("versions" in props.skill ? props.skill : null);
  const change = () =>
    live() ? latestChanges(props.view().snapshot!.changes).get(props.skill.name) : undefined;
  const unused = () => {
    const skill = live();
    return skill ? unusedDays(skill, change(), props.view().mode) : null;
  };
  const undo = () => {
    const value = change();
    return value ? undoMutationFor(value, props.view().snapshot!.list) : null;
  };
  return (
    <div
      class={[
        "sw-row",
        { "sw-row--selected": props.view().viewer?.target.name === props.skill.name },
      ]}
    >
      <button
        type="button"
        class="sw-row__main"
        aria-current={props.view().viewer?.target.name === props.skill.name ? "true" : undefined}
        onClick={() => props.view().onSelectSkill(props.skill.name)}
      >
        <Show
          when={archived()}
          fallback={
            <>
              <span class="sw-row__top">
                <span class="sw-row__name">{props.skill.name}</span>
                {unused() !== null ? (
                  <span
                    class="sw-badge sw-badge--warning"
                    title={t("skillWorkshop.unused.title", { days: String(UNUSED_ARCHIVE_DAYS) })}
                  >
                    {t("skillWorkshop.unused.badge", { days: String(unused()) })}
                  </span>
                ) : (
                  <span class="sw-row__uses">{renderUses(live()?.useCount)}</span>
                )}
              </span>
              {live()?.description && <span class="sw-row__desc">{live()?.description}</span>}
            </>
          }
        >
          {(skill) => (
            <>
              <span class="sw-row__name">{props.skill.name}</span>
              {skill().versions[0] && (
                <span class="sw-row__desc">
                  {t("skillWorkshop.skills.archivedAgo", {
                    time: formatRelativeTimestamp(skill().versions[0]!.createdAtMs),
                  })}
                </span>
              )}
            </>
          )}
        </Show>
      </button>
      <Show when={change()}>
        {(value) => (
          <div class="sw-row__change">
            <span class="sw-row__change-text">
              <WorkshopChangeText change={value()} prefix="sw-row__change-" />
            </span>
            <Show when={undo()}>
              {(mutation) => (
                <MutationButton
                  view={props.view}
                  label={t("skillWorkshop.changes.undo")}
                  title={t("skillWorkshop.changes.undoTitle", { name: value().skillName })}
                  mutation={mutation()}
                  actionKey={`undo:${value().id}`}
                  variant="link"
                />
              )}
            </Show>
          </div>
        )}
      </Show>
    </div>
  );
}
