import { normalizeLowercaseStringOrEmpty } from "@openclaw/normalization-core/string-coerce";
import { createMemo, Errored, For, isPending, latest, Loading, Show } from "solid-js";
import type { SkillStatusEntry } from "../../api/types.ts";
import { handleMarkdownCodeBlockClick } from "../../components/markdown-code-blocks.ts";
import { HubTabs } from "../../components/solid/hub-tabs.tsx";
import { Icon } from "../../components/solid/icon.tsx";
import { InlineAlert } from "../../components/solid/inline-alert.tsx";
import { RefreshButton } from "../../components/solid/refresh-button.tsx";
import { SettingsSelect } from "../../components/solid/settings-select.tsx";
import {
  SettingsEmpty,
  SettingsPage,
  SettingsStatus,
  SettingsToggle,
} from "../../components/solid/settings-ui.tsx";
import { registerSkillLibraryEnglish } from "../../i18n/locales/en-skill-library.ts";
import { registerSkillsBrowserEnglish } from "../../i18n/locales/en-skills-browser.ts";
import { formatUiError, formatUiExternalText } from "../../lib/format-error.ts";
import { clampText } from "../../lib/format.ts";
import { resolveSafeExternalUrl } from "../../lib/open-external-url.ts";
import { t } from "../../lib/reactive/i18n.ts";
import { createProgressiveList } from "../../lib/reactive/progressive-list.ts";
import "../../styles/carapace-control-ui.css";
import "../../styles/plugins.css";
import "../../styles/sidebar-markdown.css";
import { groupSkills, type SkillGroup } from "../../lib/skills-grouping.ts";
import {
  computeSkillMissing,
  computeSkillReasons,
  isSkillAvailable,
} from "../../lib/skills-shared.ts";
import type { ClawHubSkillSecurityVerdict } from "../../lib/skills/index.ts";
import { SkillDiscovery } from "./discovery-view.tsx";
import { ClawHubDetailDialog, MarkdownContent, SkillReaderDialog } from "./skill-reader-dialog.tsx";
import { SkillRowStatus, verdictForSkill, verdictStatus } from "./skill-status.tsx";
import type { SkillDetailTab, SkillsProps, SkillsStatusFilter } from "./view-types.ts";

registerSkillsBrowserEnglish();
registerSkillLibraryEnglish();

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
                  fallback={
                    <SettingsEmpty
                      message={
                        props.loading && !props.state.skillsReport
                          ? t("common.loading")
                          : emptyMessage()
                      }
                    />
                  }
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
      <Show when={detailSkill()}>{(skill) => <SkillDetail skill={skill()} view={props} />}</Show>
      <Show when={props.state.clawhubDetailRef}>
        <ClawHubDetailDialog view={props} installLocked={skillInstallLocked(props)} />
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
          label:
            props.view.loading && !props.view.state.skillsReport
              ? t(tab.labelKey)
              : `${t(tab.labelKey)} ${props.statusCounts[tab.id]}`,
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

function SkillDetail(props: { skill: SkillStatusEntry; view: SkillsProps }) {
  const updateLocked = createMemo(() => skillControlsLocked(props.view) || !props.view.canUpdate);
  const toggleSaving = () => props.view.toggleSavingSkillKey === props.skill.skillKey;
  const active = () =>
    props.view.state.skillOperation?.kind === "skill" &&
    props.view.state.skillOperation.skillKey === props.skill.skillKey;
  const homepageHref = createMemo(() =>
    resolveSafeExternalUrl(props.skill.homepage ?? "", window.location.href),
  );
  const editValue = createMemo(() => props.view.state.skillEdits[props.skill.skillKey] ?? "");
  const message = () => props.view.state.skillMessages[props.skill.skillKey] ?? null;
  const installOption = createMemo(() => {
    const missingBins = new Set([...props.skill.missing.bins, ...props.skill.missing.anyBins]);
    // An installer must provide a currently missing binary, not an unrelated dependency.
    return props.skill.install.find((option) => option.bins.some((bin) => missingBins.has(bin)));
  });
  const missing = createMemo(() => computeSkillMissing(props.skill));
  const reasons = createMemo(() => computeSkillReasons(props.skill));
  const verdict = createMemo(() => verdictForSkill(props.skill, props.view.state.clawhubVerdicts));
  const detailTab = (): SkillDetailTab =>
    props.view.state.skillsDetailTab === "card" && props.skill.skillCard?.present
      ? "card"
      : "overview";
  const hasTabs = () => Boolean(props.skill.clawhub || props.skill.skillCard?.present);
  return (
    <SkillReaderDialog
      label={props.skill.name}
      onClose={() => props.view.onDetailClose()}
      width="720px"
      title={
        <span class="exec-approval-title">
          <Show when={props.skill.emoji}>{(emoji) => <span>{emoji()}</span>}</Show>
          <span>{props.skill.name}</span>
        </span>
      }
      footer={
        <Show when={installOption() || props.skill.primaryEnv}>
          <openclaw-modal-actions class="oc-dialog__footer skill-reader-dialog__actions">
            <Show when={installOption()}>
              {(option) => (
                <button
                  class="btn"
                  disabled={skillInstallLocked(props.view)}
                  onClick={() =>
                    props.view.onInstall(props.skill.skillKey, props.skill.name, option().id)
                  }
                >
                  {active() ? t("skillsPage.installing") : option().label}
                </button>
              )}
            </Show>
            <Show when={props.skill.primaryEnv}>
              <button
                class="btn primary"
                disabled={updateLocked() || !editValue().trim()}
                onClick={() => props.view.onSaveKey(props.skill.skillKey)}
              >
                {t("skillsPage.saveKey")}
              </button>
            </Show>
          </openclaw-modal-actions>
        </Show>
      }
    >
      <div class="oc-dialog__body skill-reader-dialog__body">
        <div class="skill-detail__description">
          <p>{props.skill.description}</p>
          <Show when={!props.skill.primaryEnv && homepageHref()}>
            <a href={homepageHref()!} target="_blank" rel="noopener noreferrer">
              {props.skill.homepage}
            </a>
          </Show>
        </div>
        <Show when={hasTabs()}>
          <HubTabs
            {...{
              id: "skill-detail",
              active: detailTab(),
              tabs: [
                { value: "overview", label: t("skillsPage.overview") },
                ...(props.skill.skillCard?.present
                  ? [{ value: "card" as const, label: t("skillsPage.skillCard") }]
                  : []),
              ],
              ariaLabel: props.skill.name,
              panelId: "skill-detail-panel",
              variant: "sub",
              carapace: true,
              class: "plugins-settings-tabs",
              onSelect: props.view.onDetailTabChange,
            }}
          />
        </Show>
        <div
          id="skill-detail-panel"
          class="skill-detail__panel"
          role={hasTabs() ? "tabpanel" : undefined}
          aria-labelledby={hasTabs() ? `skill-detail-tab-${detailTab()}` : undefined}
        >
          <Show
            when={detailTab() === "overview"}
            fallback={<InstalledSkillCard skill={props.skill} view={props.view} />}
          >
            <InstalledClawHubOverview skill={props.skill} view={props.view} verdict={verdict()} />
          </Show>
        </div>
        <Show when={missing().length > 0}>
          <InlineAlert tone="warning">
            <div class="skill-detail__warning-title">{t("skillsPage.missingRequirements")}</div>
            <div>{missing().join(", ")}</div>
          </InlineAlert>
        </Show>
        <Show when={reasons().length > 0}>
          <div class="skill-detail__note">
            {t("skillsPage.reason", { reasons: reasons().join(", ") })}
          </div>
        </Show>
        <div class="oc-dialog__rows">
          <div class="oc-dialog__row">
            <SettingsStatus
              kind={props.skill.disabled ? "muted" : isSkillAvailable(props.skill) ? "ok" : "warn"}
              label={t(
                props.skill.disabled
                  ? "skillsPage.tabs.disabled"
                  : isSkillAvailable(props.skill)
                    ? "skillsPage.tabs.ready"
                    : "skillsPage.tabs.needsSetup",
              )}
            />
            <SettingsToggle
              checked={!props.skill.disabled}
              saving={toggleSaving()}
              disabled={
                !props.view.canUpdate ||
                (props.view.toggleDisabled ?? props.view.loading) ||
                (!toggleSaving() && skillControlsLocked(props.view))
              }
              ariaLabel={props.skill.name}
              onChange={() => props.view.onToggle(props.skill.skillKey, props.skill.disabled)}
            />
          </div>
          <Show when={!props.view.canUpdate}>
            <span class="oc-dialog__row-note">{t("skillsPage.updateRequiresAdmin")}</span>
          </Show>
          <div class="oc-dialog__row">
            <span class="oc-dialog__row-label">{t("skillsPage.source")}</span>
            <span>
              {props.skill.source}
              <Show when={props.skill.bundled && props.skill.source !== "openclaw-bundled"}>
                {" · "}
                {t("skillStatus.bundled")}
              </Show>
            </span>
          </div>
          <span class="oc-dialog__row-note skill-detail__path">{props.skill.filePath}</span>
        </div>
        <Show when={message()}>
          {(value) => (
            <InlineAlert tone={value().kind === "error" ? "danger" : "success"}>
              {formatUiExternalText(value().message)}
            </InlineAlert>
          )}
        </Show>
        <Show when={props.skill.primaryEnv}>
          <div class="skill-detail__key">
            <label class="field">
              <span>
                {t("skillsPage.apiKey")} <span class="muted">({props.skill.primaryEnv})</span>
              </span>
              <input
                type="password"
                required
                disabled={updateLocked()}
                value={editValue()}
                onInput={(event) =>
                  props.view.onEdit(props.skill.skillKey, event.currentTarget.value)
                }
              />
            </label>
            <Show when={homepageHref()}>
              {(href) => (
                <div class="skill-detail__note">
                  {t("skillsPage.getKey")}{" "}
                  <a href={href()} target="_blank" rel="noopener noreferrer">
                    {props.skill.homepage}
                  </a>
                </div>
              )}
            </Show>
          </div>
        </Show>
      </div>
    </SkillReaderDialog>
  );
}

function InstalledClawHubOverview(props: {
  skill: SkillStatusEntry;
  view: SkillsProps;
  verdict: ClawHubSkillSecurityVerdict | null;
}) {
  const link = () => props.skill.clawhub;
  const invalidReason = () => {
    const value = link();
    return value?.status === "invalid" ? value.reason : null;
  };
  const installedRef = () => {
    const value = link();
    return value?.status === "linked"
      ? `${value.ownerHandle ? `@${value.ownerHandle}/` : ""}${value.slug}@${value.installedVersion}`
      : "";
  };
  const auditHref = createMemo(() =>
    resolveSafeExternalUrl(props.verdict?.securityAuditUrl ?? "", window.location.href),
  );
  const feedback = () => {
    latest(props.view.readClawHubVerdicts);
    if (props.view.state.clawhubVerdictsError) {
      throw new Error(props.view.state.clawhubVerdictsError);
    }
    return props.verdict?.reasons?.length
      ? formatUiExternalText(props.verdict.reasons.join(", "))
      : null;
  };
  const status = () => {
    latest(props.view.readClawHubVerdicts);
    return verdictStatus(props.verdict, isPending(props.view.readClawHubVerdicts));
  };
  return (
    <Show when={link()}>
      {(current) => (
        <Show
          when={current().status !== "invalid"}
          fallback={
            <InlineAlert tone="danger">
              <div class="skill-detail__warning-title">{t("skillsPage.invalidLink")}</div>
              <div>{formatUiExternalText(invalidReason() ?? "")}</div>
            </InlineAlert>
          }
        >
          <div class="oc-dialog__rows">
            <div class="oc-dialog__row">
              <span class="oc-dialog__row-label">{t("skillsPage.package")}</span>
              <span>{installedRef()}</span>
            </div>
            <div class="oc-dialog__row">
              <span class="oc-dialog__row-label">{t("skillsPage.securityCheck")}</span>
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
                  <Show
                    when={props.verdict && isPending(props.view.readClawHubVerdicts)}
                    fallback={<SettingsStatus {...status()} />}
                  >
                    <SettingsStatus kind="muted" label={t("skillsPage.refreshing")} />
                  </Show>
                </Loading>
              </Errored>
            </div>
            <Errored
              fallback={(error) => (
                <Loading>
                  <Show when={!isPending(props.view.readClawHubVerdicts)}>
                    <div class="skill-detail__note">{formatUiError(error())}</div>
                  </Show>
                </Loading>
              )}
            >
              <Loading>
                <Show when={feedback()}>
                  {(value) => <div class="skill-detail__note">{value()}</div>}
                </Show>
              </Loading>
            </Errored>
            <Show when={auditHref()}>
              {(href) => (
                <div class="skill-detail__note">
                  <a href={href()} target="_blank" rel="noopener noreferrer">
                    {t("skillsPage.fullSecurityReport")}
                  </a>
                </div>
              )}
            </Show>
          </div>
        </Show>
      )}
    </Show>
  );
}

function InstalledSkillCard(props: { skill: SkillStatusEntry; view: SkillsProps }) {
  const acceptedContent = createMemo(
    () => props.view.state.skillCardContents[props.skill.skillKey],
  );
  const completion = createMemo(() => props.view.state.skillCardReads[props.skill.skillKey]);
  const read = createMemo(() => {
    const receipt = completion();
    const value = acceptedContent();
    const error = props.view.state.skillCardErrors[props.skill.skillKey] ?? null;
    return receipt?.completion ?? Promise.resolve({ value, error });
  });
  const CardContent = () => {
    const content = createMemo(() => {
      const accepted = acceptedContent();
      if (accepted !== undefined) {
        return accepted;
      }
      const outcome = read();
      if (outcome.error) {
        throw new Error(outcome.error);
      }
      return outcome.value;
    });
    return (
      <Show
        when={content() !== undefined}
        fallback={
          <div class="muted" role="status" style={{ "font-size": "13px" }}>
            {t("skillsPage.skillCardNotLoaded")}
          </div>
        }
      >
        <MarkdownContent
          class="sidebar-markdown"
          style={{ "max-width": "100%", "overflow-wrap": "anywhere" }}
          onClick={handleMarkdownCodeBlockClick}
          content={content() ?? ""}
        />
      </Show>
    );
  };
  return (
    <Show when={props.skill.skillCard?.present}>
      <Loading
        on={acceptedContent() === undefined ? completion() : null}
        fallback={
          <div class="muted" role="status" style={{ "font-size": "13px" }}>
            {t("skillsPage.loadingSkillCard")}
          </div>
        }
      >
        <Errored
          fallback={(error) => (
            <InlineAlert tone="danger" role="alert">
              {formatUiError(error())}
            </InlineAlert>
          )}
        >
          <CardContent />
        </Errored>
      </Loading>
    </Show>
  );
}
