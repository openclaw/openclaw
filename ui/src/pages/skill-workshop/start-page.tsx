import type {
  SkillsWorkshopListResult,
  SkillWorkshopChange,
  SkillWorkshopDraft,
  SkillWorkshopSkillSummary,
} from "@openclaw/gateway-protocol";
import { createMemo, createSignal, createUniqueId, For, Show } from "solid-js";
import { AgentScopeControl } from "../../components/agent-scope-control.tsx";
import { CatalogDiscoverySearch } from "../../components/solid/catalog-discovery.tsx";
import { Icon } from "../../components/solid/icon.tsx";
import { SettingsEmpty, SettingsSegmented } from "../../components/solid/settings-ui.tsx";
import { formatRelativeTimestamp } from "../../lib/format.ts";
import { t } from "../../lib/reactive/i18n.ts";
import { canRunWorkshopMutation } from "./access.ts";
import { diffCounts } from "./diff.tsx";
import { DraftContent } from "./draft-detail.tsx";
import {
  archivedWorkshopSkills,
  MutationButton,
  renderUses,
  sortWorkshopSkills,
  UNUSED_ARCHIVE_DAYS,
  unusedDays,
  workshopHistory,
  type WorkshopFilter,
  type WorkshopPage,
  type WorkshopReads,
  type WorkshopSort,
  type WorkshopStartView,
  type WorkshopView,
} from "./view-shared.tsx";

const SORTS: readonly WorkshopSort[] = ["uses", "recent", "name"];
const FILTERS: readonly WorkshopFilter[] = ["active", "archived"];

type StartProps = { view: WorkshopView; reads: WorkshopReads; page: WorkshopPage };
type SkillRowEntry = SkillWorkshopSkillSummary | SkillsWorkshopListResult["archived"][number];
type HistoryGroup = { key: "today" | "thisWeek" | "earlier"; changes: SkillWorkshopChange[] };

/**
 * The start page asks three questions in order: does a draft wait for me, what changed, and
 * where is that skill. Each is one view; a skill or draft then opens as its own page.
 */
export function StartPage(props: StartProps & { query: string; onQuery: (query: string) => void }) {
  const list = () => props.view().snapshot!.list;
  const archived = createMemo(() => archivedWorkshopSkills(list()));
  // Newest first, like an inbox.
  const drafts = createMemo(() => (list().drafts ?? []).toReversed());
  const history = createMemo(() => workshopHistory(props.view().snapshot!));
  const views = createMemo<WorkshopStartView[]>(() =>
    props.view().draftsShown ? ["drafts", "history", "skills"] : ["history", "skills"],
  );
  const label = (view: WorkshopStartView) =>
    view === "drafts"
      ? t("skillWorkshop.skills.drafts")
      : view === "history"
        ? t("skillWorkshop.tabs.history")
        : t("skillWorkshop.skills.title");
  const count = (view: WorkshopStartView) =>
    view === "drafts" ? drafts().length : view === "skills" ? list().skills.length : null;
  const empty = () =>
    list().skills.length === 0 &&
    archived().length === 0 &&
    drafts().length === 0 &&
    history().length === 0 &&
    props.view().startView !== "drafts";
  return (
    <Show
      when={!empty()}
      fallback={
        <>
          <Show when={props.view().allAgentsScope}>
            <div class="sw-library__bar">
              <span />
              <AgentScope view={props.view} />
            </div>
          </Show>
          <div class="sw-empty oc-settings-group settings-group">
            <span class="sw-empty__icon" aria-hidden="true">
              <Icon name="wandSparkles" />
            </span>
            <p>{t("skillWorkshop.skills.empty")}</p>
          </div>
        </>
      }
    >
      <section class="sw-library" aria-label={t("skillWorkshop.views.aria")}>
        <div class="sw-library__bar sw-views-bar">
          <SettingsSegmented
            mode="buttons"
            class="sw-views"
            ariaLabel={t("skillWorkshop.views.aria")}
            value={props.view().startView}
            options={views().map((value) => ({
              value,
              label: (
                <>
                  {label(value)}
                  {count(value) !== null && (
                    <>
                      {" "}
                      <span class="settings-count">{count(value)}</span>
                    </>
                  )}
                </>
              ),
            }))}
            onChange={(view) => props.view().onStartView(view)}
          />
          <Show when={props.view().allAgentsScope}>
            <AgentScope view={props.view} />
          </Show>
        </div>
        <Show when={props.view().startView === "drafts"}>
          <Drafts view={props.view} reads={props.reads} page={props.page} drafts={drafts()} />
        </Show>
        <Show when={props.view().startView === "history"}>
          <History view={props.view} page={props.page} changes={history()} />
        </Show>
        <Show when={props.view().startView === "skills"}>
          <LearnedSkills
            view={props.view}
            reads={props.reads}
            page={props.page}
            archived={archived()}
            query={props.query}
            onQuery={props.onQuery}
          />
        </Show>
      </section>
    </Show>
  );
}

/** The workshop follows the active agent; the picker shows only in the sidebar's Show All mode. */
function AgentScope(props: { view: WorkshopView }) {
  return (
    <AgentScopeControl
      agents={props.view().context.agents.state.agentsList?.agents ?? []}
      selection={props.view().context.agentSelection}
      selectedId={props.view().agentId}
      allowAll={false}
    />
  );
}

function SkillTile() {
  return (
    <span class="sw-tile" aria-hidden="true">
      <Icon name="wandSparkles" />
    </span>
  );
}

function Drafts(props: StartProps & { drafts: SkillWorkshopDraft[] }) {
  // A draft row opens its diff in place; the selected draft is the open one until it is closed.
  const [closedDraft, setClosedDraft] = createSignal<string | null>(null);
  return (
    <div class="sw-list__rows sw-queue">
      <For
        each={props.drafts}
        keyed={(draft) => draft.id}
        fallback={<SettingsEmpty message={t("skillWorkshop.skills.noneDrafts")} carapace />}
      >
        {(draft) => (
          <DraftRow
            draft={draft()}
            view={props.view}
            reads={props.reads}
            page={props.page}
            closed={closedDraft() === draft().id}
            onToggle={(open) => setClosedDraft(open ? null : draft().id)}
          />
        )}
      </For>
    </div>
  );
}

/** Today, this week (the six days before today) and earlier, by the change's local date. */
function groupHistory(changes: readonly SkillWorkshopChange[]): HistoryGroup[] {
  const start = new Date();
  start.setHours(0, 0, 0, 0);
  const today = start.getTime();
  start.setDate(start.getDate() - 6);
  const week = start.getTime();
  const groups: HistoryGroup[] = [
    { key: "today", changes: [] },
    { key: "thisWeek", changes: [] },
    { key: "earlier", changes: [] },
  ];
  for (const change of changes) {
    const index = change.createdAtMs >= today ? 0 : change.createdAtMs >= week ? 1 : 2;
    groups[index]!.changes.push(change);
  }
  return groups.filter((group) => group.changes.length > 0);
}

function History(props: Pick<StartProps, "view" | "page"> & { changes: SkillWorkshopChange[] }) {
  const groups = createMemo(() => groupHistory(props.changes));
  return (
    <Show
      when={props.changes.length > 0}
      fallback={
        <div class="sw-list__rows sw-queue">
          <SettingsEmpty message={t("skillWorkshop.changes.empty")} carapace />
        </div>
      }
    >
      <div class="sw-history-list">
        <For each={groups()} keyed={(group) => group.key}>
          {(group) => (
            <section class="sw-group">
              <h3 class="sw-group__title">{t(`skillWorkshop.history.${group().key}`)}</h3>
              <div class="sw-list__rows sw-queue">
                <For each={group().changes} keyed={(change) => change.id}>
                  {(change) => <HistoryRow change={change()} view={props.view} page={props.page} />}
                </For>
              </div>
            </section>
          )}
        </For>
      </div>
    </Show>
  );
}

/** A row opens the individual skill's History, where changes can be compared or undone. */
function HistoryRow(props: Pick<StartProps, "view" | "page"> & { change: SkillWorkshopChange }) {
  return (
    <div class="sw-row sw-row--history">
      <button
        type="button"
        class="sw-row__main"
        onClick={() => {
          props.view().onSelectSkill(props.change.skillName);
          props.view().onTab("history");
          props.page.open();
        }}
      >
        <SkillTile />
        <span class="sw-row__text">
          <span class="sw-row__name">{props.change.skillName}</span>
          <span class="sw-row__change">
            <span class="sw-row__change-who">
              {t(`skillWorkshop.changes.actors.${props.change.actor}`)}{" "}
              {t(`skillWorkshop.changes.actions.${props.change.action}`)}
            </span>
            {props.change.summary && <span class="sw-row__change-why">{props.change.summary}</span>}
          </span>
        </span>
        <span class="sw-row__when">{formatRelativeTimestamp(props.change.createdAtMs)}</span>
      </button>
    </div>
  );
}

function LearnedSkills(
  props: StartProps & {
    archived: SkillsWorkshopListResult["archived"];
    query: string;
    onQuery: (query: string) => void;
  },
) {
  const list = () => props.view().snapshot!.list;
  // The list method returns every skill of the agent, so the search filters the whole library.
  const needle = () => props.query.trim().toLowerCase();
  const matches = (text: string) => !needle() || text.toLowerCase().includes(needle());
  const rows = createMemo<SkillRowEntry[]>(() =>
    props.view().filter === "active"
      ? sortWorkshopSkills(list().skills, props.view().snapshot!.changes, props.view().sort).filter(
          (skill) => matches(`${skill.name} ${skill.description ?? ""}`),
        )
      : props.archived.filter((skill) => matches(skill.name)),
  );
  const count = (filter: WorkshopFilter) =>
    filter === "active" ? list().skills.length : props.archived.length;
  return (
    <div class="sw-skills">
      <CatalogDiscoverySearch>
        <input
          type="search"
          class="settings-input"
          name="skill-workshop-search"
          autocomplete="off"
          aria-label={t("skillWorkshop.skills.search")}
          placeholder={t("skillWorkshop.skills.search")}
          value={props.query}
          onInput={(event) => props.onQuery(event.currentTarget.value)}
        />
      </CatalogDiscoverySearch>
      <div class="sw-library__bar">
        <SettingsSegmented
          mode="buttons"
          class="sw-library__filters"
          ariaLabel={t("skillWorkshop.skills.filterAria")}
          value={props.view().filter}
          options={FILTERS.map((value) => ({
            value,
            label: (
              <>
                {t(`skillWorkshop.skills.${value}`)}{" "}
                <span class="settings-count">{count(value)}</span>
              </>
            ),
          }))}
          onChange={(filter) => props.view().onFilter(filter)}
        />
        <Show when={props.view().filter === "active"}>
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
        </Show>
      </div>
      <div class="sw-list__rows sw-grid">
        <For
          each={rows()}
          keyed={(skill) => skill.name}
          fallback={
            <SettingsEmpty
              message={t(
                needle()
                  ? "skillWorkshop.skills.noMatches"
                  : props.view().filter === "active"
                    ? "skillWorkshop.skills.noneActive"
                    : "skillWorkshop.skills.noneArchived",
              )}
              carapace
            />
          }
        >
          {(skill) => <SkillRow skill={skill()} view={props.view} page={props.page} />}
        </For>
      </div>
    </div>
  );
}

/** A learned skill: what it is and how much it is used. */
function SkillRow(props: { skill: SkillRowEntry; view: WorkshopView; page: WorkshopPage }) {
  const live = () => ("versions" in props.skill ? null : props.skill);
  const archived = () => ("versions" in props.skill ? props.skill : null);
  const unused = () => {
    const skill = live();
    if (!skill) {
      return null;
    }
    const change = props.view().snapshot!.changes.find((entry) => entry.skillName === skill.name);
    return unusedDays(skill, change, props.view().mode);
  };
  return (
    <div class="sw-row">
      <button
        type="button"
        class="sw-row__main"
        onClick={() => {
          props.view().onSelectSkill(props.skill.name);
          props.page.open();
        }}
      >
        <SkillTile />
        <span class="sw-row__text">
          <span class="sw-row__name">{props.skill.name}</span>
          <Show
            when={archived()}
            fallback={
              live()?.description && <span class="sw-row__desc">{live()?.description}</span>
            }
          >
            {(skill) =>
              skill().versions[0] && (
                <span class="sw-row__desc">
                  {t("skillWorkshop.skills.archivedAgo", {
                    time: formatRelativeTimestamp(skill().versions[0]!.createdAtMs),
                  })}
                </span>
              )
            }
          </Show>
        </span>
      </button>
      <Show when={live()}>
        <div class="sw-row__aside">
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
        </div>
      </Show>
    </div>
  );
}

function DraftRow(props: {
  draft: SkillWorkshopDraft;
  view: WorkshopView;
  reads: WorkshopReads;
  page: WorkshopPage;
  closed: boolean;
  onToggle: (open: boolean) => void;
}) {
  const selected = () => props.view().viewer?.target.draftId === props.draft.id;
  const open = () => selected() && !props.closed;
  const bodyId = `sw-draft-${createUniqueId()}`;
  const liveSkill = () =>
    props.view().snapshot!.list.skills.find((skill) => skill.name === props.draft.skillName);
  // Line counts come from the open row's loaded diff; closed rows load nothing to count.
  const counts = createMemo(() => {
    const viewer = props.view().viewer;
    if (
      !open() ||
      viewer?.target.draftId !== props.draft.id ||
      viewer.target.filePath !== "SKILL.md" ||
      viewer.current === undefined ||
      !viewer.result
    ) {
      return null;
    }
    const lines = diffCounts(viewer.current, viewer.result.content);
    return lines && lines.add + lines.remove > 0 ? lines : null;
  });
  const canApply = () => canRunWorkshopMutation(props.view().access, "skills.workshop.applyDraft");
  const mutation = (method: "skills.workshop.applyDraft" | "skills.workshop.discardDraft") => ({
    method,
    name: props.draft.skillName,
    draftId: props.draft.id,
  });
  const actions = () => (
    <>
      <MutationButton
        view={props.view}
        label={t("skillWorkshop.drafts.discard")}
        title={t("skillWorkshop.drafts.discardTitle")}
        mutation={mutation("skills.workshop.discardDraft")}
        actionKey={`discard:${props.draft.id}`}
      />
      <MutationButton
        view={props.view}
        label={t("skillWorkshop.drafts.apply")}
        title={t(
          liveSkill()
            ? "skillWorkshop.drafts.applyUpdateTitle"
            : "skillWorkshop.drafts.applyNewTitle",
        )}
        mutation={mutation("skills.workshop.applyDraft")}
        actionKey={`apply:${props.draft.id}`}
        variant={open() ? "primary" : "default"}
      />
    </>
  );
  return (
    <div class={["sw-row sw-row--draft", { "sw-row--open": open() }]}>
      <div class="sw-row__head">
        <button
          type="button"
          class="sw-row__main"
          aria-expanded={open() ? "true" : "false"}
          aria-controls={bodyId}
          onClick={() => {
            if (open()) {
              props.onToggle(false);
            } else {
              props.onToggle(true);
              if (!selected()) {
                props.view().onSelectDraft(props.draft.id);
              }
            }
          }}
        >
          <span class="sw-row__chevron" aria-hidden="true">
            <Icon name="chevronRight" />
          </span>
          <SkillTile />
          <span class="sw-row__text">
            <span class="sw-row__title">
              <span class="sw-row__name">{props.draft.skillName}</span>
              <span class={["sw-tag", { "sw-tag--new": !liveSkill() }]}>
                {t(liveSkill() ? "skillWorkshop.drafts.update" : "skillWorkshop.drafts.newSkill")}
              </span>
              <Show when={counts()}>
                {(lines) => (
                  <span class="sw-row__counts">
                    <span class="sw-row__count--add">+{lines().add}</span>
                    <span class="sw-row__count--remove">−{lines().remove}</span>
                  </span>
                )}
              </Show>
            </span>
            {props.draft.summary && <span class="sw-row__desc">{props.draft.summary}</span>}
            {/* On a phone the uses and age read under the summary. */}
            <span class="sw-row__meta">
              <Show when={liveSkill()}>
                {(skill) => <span class="sw-row__meta-uses">{renderUses(skill().useCount)}</span>}
              </Show>
              <span class="sw-row__meta-when">
                {formatRelativeTimestamp(props.draft.createdAtMs)}
              </span>
            </span>
          </span>
        </button>
        <Show when={!open()}>
          <div class="sw-row__aside sw-row__aside--draft">{actions()}</div>
        </Show>
      </div>
      <Show when={open()}>
        <div class="sw-row__body" id={bodyId}>
          <div
            class="sw-row__preview"
            role="group"
            aria-label={t("skillWorkshop.drafts.preview")}
            tabindex={0}
          >
            <DraftContent reads={props.reads} />
          </div>
          <div class="sw-row__foot">
            <Show when={liveSkill() && canApply()}>
              <span class="sw-row__note">{t("skillWorkshop.drafts.savedFirst")}</span>
            </Show>
            <button type="button" class="btn btn--sm oc-action" onClick={() => props.page.open()}>
              {t("skillWorkshop.drafts.open")}
            </button>
            {actions()}
          </div>
        </div>
      </Show>
    </div>
  );
}
