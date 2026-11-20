import type {
  SkillsWorkshopListResult,
  SkillWorkshopChange,
  SkillWorkshopDraft,
  SkillWorkshopSkillSummary,
} from "@openclaw/gateway-protocol";
import { createMemo, createSignal, createUniqueId, Errored, For, Loading, Show } from "solid-js";
import { AgentScopeControl } from "../../components/agent-scope-control.tsx";
import { ErrorDetails } from "../../components/config-error.tsx";
import { Icon } from "../../components/solid/icon.tsx";
import { InlineAlert } from "../../components/solid/inline-alert.tsx";
import {
  SettingsEmpty,
  SettingsLoadingSkeleton,
  SettingsPage,
  SettingsSegmented,
} from "../../components/solid/settings-ui.tsx";
import { SettingsWorkspace } from "../../components/solid/settings-workspace.tsx";
import { registerSkillWorkshopEnglish } from "../../i18n/locales/en-skill-workshop.ts";
import { formatUiError } from "../../lib/format-error.ts";
import { formatRelativeTimestamp } from "../../lib/format.ts";
import { useApplication } from "../../lib/reactive/context.ts";
import { registerEnglishCatalog, t } from "../../lib/reactive/i18n.ts";
import { createPendingFocus } from "../../lib/reactive/pending-focus.ts";
import "../../styles/chat/text.css";
import "../../styles/carapace-control-ui.css";
import "../../styles/plugins.css";
import "../../styles/skill-workshop.css";
import { resolveScrollBehavior } from "../../lib/scroll-behavior.ts";
import { PluginsHubHeader } from "../plugins/plugins-hub-header.tsx";
import { PLUGINS_HUB_PANEL_ID, pluginsHubPanel } from "../plugins/plugins-hub.ts";
import { Detail } from "./detail.tsx";
import { DraftContent, DraftDetail } from "./draft-detail.tsx";
import { LearningControl } from "./learning-control.tsx";
import {
  lastActivityMs,
  latestChanges,
  MutationButton,
  renderUses,
  WorkshopChangeText,
  UNUSED_ARCHIVE_DAYS,
  unusedDays,
  type WorkshopFilter,
  type WorkshopPage,
  type WorkshopSort,
  type WorkshopView,
  type WorkshopReads,
} from "./view-shared.tsx";
export type {
  WorkshopFilter,
  WorkshopSort,
  WorkshopTab,
  WorkshopViewer,
  WorkshopViewerTarget,
} from "./view-shared.tsx";

registerEnglishCatalog(registerSkillWorkshopEnglish);
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

export function SkillWorkshopView(props: { view: WorkshopView; reads: WorkshopReads }) {
  // Turning the plugin on replaces the focused button with the Workshop; keep focus in the panel.
  createPendingFocus(
    () => {
      const plugin = props.view().plugin;
      return plugin?.status === "off" && plugin.enabling
        ? "enabling"
        : (plugin?.status ?? "loaded");
    },
    {
      requested: (next, previous) => previous === "enabling" && next === "loaded",
      focus: () => {
        const panel = document.getElementById(PLUGINS_HUB_PANEL_ID);
        if (panel && (!document.activeElement || document.activeElement === document.body)) {
          panel.tabIndex = -1;
          panel.focus({ preventScroll: true });
        }
      },
    },
  );
  // The list is the start page; a skill or draft opens as its own page over the same selection.
  // A chat notice link (?skill=<name>) arrives for one skill, so it opens on that skill's page.
  const [pageOpen, setPageOpen] = createSignal(
    new URLSearchParams(useApplication().router.getState().location.search).has("skill"),
  );
  let panel: HTMLElement | undefined;
  const page: WorkshopPage = {
    // A row low in a long list opens its page from the top; the breadcrumb back is already there.
    open: () => {
      setPageOpen(true);
      panel?.scrollIntoView({ block: "start", behavior: resolveScrollBehavior("auto") });
    },
    close: () => setPageOpen(false),
  };
  // Without a selection (the last draft was discarded, another agent was picked) the list shows.
  const detail = () =>
    pageOpen() && !props.view().plugin && props.view().snapshot && props.view().viewer;
  return (
    <>
      <Show when={!detail()}>
        <PluginsHubHeader
          active="skill-workshop"
          class="sw-hub-header"
          onSelect={(tab) => props.view().context.navigate(tab)}
          actions={
            <Show when={!props.view().plugin}>
              <LearningControl view={props.view} />
            </Show>
          }
        />
      </Show>
      <SettingsWorkspace>
        <div
          {...pluginsHubPanel("skill-workshop")}
          ref={(element: HTMLElement) => {
            panel = element;
          }}
        >
          <SettingsPage wide carapace>
            <Show when={!props.view().plugin} fallback={<PluginUnavailable view={props.view} />}>
              <Show
                when={detail()}
                fallback={
                  <>
                    <PageErrors view={props.view} />
                    <Loading
                      on={props.reads.listRequest()}
                      fallback={!props.view().snapshot && <SettingsLoadingSkeleton carapace />}
                    >
                      <Errored
                        fallback={(error, reset) => (
                          <ErrorBanner
                            message={`${t("skillWorkshop.loadError")} ${formatUiError(error())}`}
                            onRetry={() => {
                              props.view().onRetry();
                              reset();
                            }}
                          />
                        )}
                      >
                        {props.reads.list() && null}
                      </Errored>
                    </Loading>
                    <Show when={props.view().snapshot}>
                      <Library view={props.view} reads={props.reads} page={page} />
                    </Show>
                  </>
                }
              >
                <Show
                  when={props.view().viewer?.target.draftId}
                  fallback={
                    <Detail
                      view={props.view}
                      reads={props.reads}
                      page={page}
                      errors={<PageErrors view={props.view} />}
                    />
                  }
                >
                  <DraftDetail
                    view={props.view}
                    reads={props.reads}
                    page={page}
                    errors={<PageErrors view={props.view} />}
                  />
                </Show>
              </Show>
            </Show>
          </SettingsPage>
        </div>
      </SettingsWorkspace>
    </>
  );
}

function PageErrors(props: { view: WorkshopView }) {
  return (
    <>
      <For
        each={[props.view().learningError, props.view().modeError, props.view().actionError].filter(
          Boolean,
        )}
      >
        {(message) => <ErrorBanner message={message ?? ""} />}
      </For>
      {props.view().error && (
        <ErrorBanner
          message={`${t("skillWorkshop.loadError")} ${props.view().error}`}
          onRetry={props.view().onRetry}
        />
      )}
    </>
  );
}

/** The Gateway serves no Workshop methods: explain why, and turn the plugin on when allowed. */
function PluginUnavailable(props: { view: WorkshopView }) {
  const state = () => props.view().plugin;
  const off = () => {
    const current = state();
    return current?.status === "off" ? current : undefined;
  };
  const failure = () => {
    const current = state();
    return current?.status === "error" ? current : undefined;
  };
  const message = () => {
    const status = state()?.status;
    return status === "missing"
      ? t("skillWorkshop.plugin.missing")
      : status === "failed"
        ? t("skillWorkshop.plugin.failed")
        : status === "reload"
          ? t("skillWorkshop.plugin.reload")
          : props.view().pluginsDisabled
            ? t("skillWorkshop.plugin.pluginsDisabled")
            : props.view().access.canEnablePlugin
              ? t("skillWorkshop.plugin.offBody")
              : t("skillWorkshop.plugin.needsAdmin");
  };
  return (
    <Show when={state()?.status !== "checking"} fallback={<SettingsLoadingSkeleton carapace />}>
      <Show
        when={failure()}
        fallback={
          <div class="sw-empty sw-plugin-off oc-settings-group settings-group">
            <span class="sw-empty__icon" aria-hidden="true">
              <Icon name="wandSparkles" />
            </span>
            <Show when={off()}>
              <strong class="sw-empty__title">{t("skillWorkshop.plugin.offTitle")}</strong>
            </Show>
            <p>{message()}</p>
            <Show when={off()}>
              {(current) => (
                <Show when={props.view().access.canEnablePlugin && !props.view().pluginsDisabled}>
                  {/* aria-disabled keeps focus on the button while the Gateway works. */}
                  <button
                    type="button"
                    class="btn primary"
                    aria-disabled={current().enabling ? "true" : undefined}
                    aria-busy={current().enabling ? "true" : undefined}
                    onClick={() => props.view().onEnablePlugin()}
                  >
                    {current().enabling
                      ? t("skillWorkshop.plugin.enabling")
                      : t("skillWorkshop.plugin.enable")}
                  </button>
                </Show>
              )}
            </Show>
            <Show when={state()?.status === "reload"}>
              <button type="button" class="btn primary" onClick={() => location.reload()}>
                {t("common.reload")}
              </button>
            </Show>
            <Show when={off()?.error} keyed>
              {(error) => (
                <ErrorBanner message={t("skillWorkshop.plugin.enableFailed")} error={error} />
              )}
            </Show>
          </div>
        }
      >
        {(current) => (
          <ErrorBanner
            message={t("skillWorkshop.plugin.checkFailed")}
            error={current().error}
            onRetry={props.view().onRetryPlugin}
          />
        )}
      </Show>
    </Show>
  );
}

function ErrorBanner(props: { message: string; error?: unknown; onRetry?: () => void }) {
  return (
    <InlineAlert
      tone="danger"
      action={
        props.onRetry && (
          <button type="button" class="btn btn--sm" onClick={() => props.onRetry?.()}>
            {t("skillWorkshop.retry")}
          </button>
        )
      }
    >
      {props.message}
      {props.error != null && <ErrorDetails error={props.error} />}
    </InlineAlert>
  );
}

type SkillRowEntry = SkillWorkshopSkillSummary | SkillsWorkshopListResult["archived"][number];
function Library(props: { view: WorkshopView; reads: WorkshopReads; page: WorkshopPage }) {
  const list = () => props.view().snapshot!.list;
  const archived = createMemo(() => archivedWorkshopSkills(list()));
  // Newest first, like an inbox.
  const drafts = createMemo(() => (list().drafts ?? []).toReversed());
  const rows = createMemo<SkillRowEntry[]>(() =>
    props.view().filter === "active"
      ? sortWorkshopSkills(list().skills, props.view().snapshot!.changes, props.view().sort)
      : archived(),
  );
  // The Drafts list appears once drafts can exist: in Propose mode, while any wait, or while it
  // is the open list (discarding its last draft must not leave no list selected).
  const filters = createMemo<WorkshopFilter[]>(() =>
    props.view().mode === "propose" || drafts().length > 0 || props.view().filter === "drafts"
      ? ["active", "drafts", "archived"]
      : ["active", "archived"],
  );
  const count = (filter: WorkshopFilter) =>
    filter === "active"
      ? list().skills.length
      : filter === "drafts"
        ? drafts().length
        : archived().length;
  // A draft row opens its diff in place; the selected draft is the open one until it is closed.
  const [closedDraft, setClosedDraft] = createSignal<string | null>(null);
  return (
    <Show
      when={
        list().skills.length > 0 ||
        archived().length > 0 ||
        drafts().length > 0 ||
        props.view().filter === "drafts"
      }
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
      <section class="sw-library" aria-label={t("skillWorkshop.skills.title")}>
        <div class="sw-library__bar">
          <SettingsSegmented
            mode="buttons"
            class="sw-library__filters"
            ariaLabel={t("skillWorkshop.skills.filterAria")}
            value={props.view().filter}
            options={filters().map((value) => ({
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
          <div class="sw-library__tools">
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
            <Show when={props.view().allAgentsScope}>
              <AgentScope view={props.view} />
            </Show>
          </div>
        </div>
        <Show
          when={props.view().filter === "drafts"}
          fallback={
            <div class="sw-list__rows sw-grid">
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
                {(skill) => <SkillRow skill={skill()} view={props.view} page={props.page} />}
              </For>
            </div>
          }
        >
          <div class="sw-list__rows sw-queue">
            <For
              each={drafts()}
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

function SkillRow(props: { skill: SkillRowEntry; view: WorkshopView; page: WorkshopPage }) {
  const live = () => ("versions" in props.skill ? null : props.skill);
  const archived = () => ("versions" in props.skill ? props.skill : null);
  const change = createMemo(() =>
    live()
      ? props.view().snapshot!.changes.find((entry) => entry.skillName === props.skill.name)
      : undefined,
  );
  const unused = () => {
    const skill = live();
    return skill ? unusedDays(skill, change(), props.view().mode) : null;
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
              <>
                {live()?.description && <span class="sw-row__desc">{live()?.description}</span>}
                {/* On a phone the uses move into this last line; the right slot keeps the Unused badge. */}
                <Show when={change() || unused() === null}>
                  <span class={["sw-row__change", { "sw-row__change--uses-only": !change() }]}>
                    <Show when={unused() === null}>
                      <span class="sw-row__change-uses">{renderUses(live()?.useCount)}</span>
                    </Show>
                    <Show when={change()}>
                      {(value) => <WorkshopChangeText change={value()} prefix="sw-row__change-" />}
                    </Show>
                  </span>
                </Show>
              </>
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
            <span class="sw-row__uses sw-row__uses--aside">{renderUses(live()?.useCount)}</span>
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
  const live = () =>
    props.view().snapshot!.list.skills.some((skill) => skill.name === props.draft.skillName);
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
          live() ? "skillWorkshop.drafts.applyUpdateTitle" : "skillWorkshop.drafts.applyNewTitle",
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
              <span class="sw-tag">
                {t(live() ? "skillWorkshop.drafts.update" : "skillWorkshop.drafts.newSkill")}
              </span>
            </span>
            {props.draft.summary && <span class="sw-row__desc">{props.draft.summary}</span>}
          </span>
          <span class="sw-row__uses">
            {t("skillWorkshop.drafts.proposed", {
              time: formatRelativeTimestamp(props.draft.createdAtMs),
            })}
          </span>
        </button>
        {/* The slot stays when the row is open so every row's time ends at the same edge. */}
        <div class="sw-row__aside sw-row__aside--draft">
          <Show when={!open()}>{actions()}</Show>
        </div>
      </div>
      <Show when={open()}>
        <div class="sw-row__body" id={bodyId}>
          <div class="sw-row__preview">
            <DraftContent reads={props.reads} />
          </div>
          <div class="sw-row__foot">
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
