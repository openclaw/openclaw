import { normalizeLowercaseStringOrEmpty } from "@openclaw/normalization-core/string-coerce";
import { createMemo, For, Show } from "solid-js";
import type { SkillStatusEntry } from "../../api/types.ts";
import { renderHubTabs } from "../../components/hub-tabs.ts";
import { handleMarkdownCodeBlockClick } from "../../components/markdown-code-blocks.ts";
import { Icon } from "../../components/solid/icon.tsx";
import {
  SettingsEmpty,
  SettingsPage,
  SettingsSegmented,
  SettingsStatus,
  SettingsToggle,
} from "../../components/solid/settings-ui.tsx";
import { registerSkillLibraryEnglish } from "../../i18n/locales/en-skill-library.ts";
import { registerSkillsBrowserEnglish } from "../../i18n/locales/en-skills-browser.ts";
import { formatUiExternalText } from "../../lib/format-error.ts";
import { clampText } from "../../lib/format.ts";
import { resolveSafeExternalUrl } from "../../lib/open-external-url.ts";
import { t } from "../../lib/reactive/i18n.ts";
import { groupSkills, type SkillGroup } from "../../lib/skills-grouping.ts";
import "../../styles/plugins.css";
import "../../styles/sidebar-markdown.css";
import {
  computeSkillMissing,
  computeSkillReasons,
  isSkillAvailable,
  renderSkillStatusChips,
} from "../../lib/skills-shared.ts";
import type { ClawHubSkillSecurityVerdict } from "../../lib/skills/index.ts";
import { LitContent } from "../../lit/solid-bridge.ts";
import { SkillDiscovery } from "./discovery-view.tsx";
import { ClawHubDetailDialog, MarkdownContent, SkillReaderDialog } from "./skill-reader-dialog.tsx";
import { SkillStateStatus, verdictForSkill, verdictStatus } from "./skill-status.tsx";
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
  return view.loading || view.state.skillOperation !== null;
}

function skillInstallLocked(view: SkillsProps): boolean {
  return skillControlsLocked(view) || !view.canInstall;
}

export function Skills(props: SkillsProps) {
  const skills = createMemo(() => props.state.skillsReport?.skills ?? []);
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
  const filtered = createMemo(() => {
    const afterStatus =
      props.state.skillsStatusFilter === "all"
        ? skills()
        : skills().filter((skill) => skillStatus(skill) === props.state.skillsStatusFilter);
    const filter = normalizeLowercaseStringOrEmpty(props.state.skillsFilter);
    return filter
      ? afterStatus.filter((skill) =>
          normalizeLowercaseStringOrEmpty(
            [skill.name, skill.description, skill.source].join(" "),
          ).includes(filter),
        )
      : afterStatus;
  });
  const groups = createMemo(() => groupSkills(filtered()));
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
                <SkillsToolbar
                  view={props}
                  statusCounts={statusCounts()}
                  shownCount={filtered().length}
                />
              </Show>
              <Show when={props.error}>
                {(error) => (
                  <div class="callout danger" role="alert">
                    {error()}
                  </div>
                )}
              </Show>
              <Show when={props.showInventory !== false}>
                <Show
                  when={filtered().length > 0}
                  fallback={
                    <SettingsEmpty
                      message={
                        !props.state.connected && !props.state.skillsReport
                          ? t("skillsPage.disconnected")
                          : t("skillsPage.empty")
                      }
                    />
                  }
                >
                  <For each={groups()} keyed={(group) => group.id}>
                    {(group) => <SkillGroupView group={group()} view={props} />}
                  </For>
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

function SkillGroupView(props: { group: SkillGroup; view: SkillsProps }) {
  return (
    <details class="settings-section skills-group" open>
      <summary class="settings-section__header skills-group__summary">
        <h2 class="settings-section__heading">
          {props.group.label} <span class="settings-count">{props.group.skills.length}</span>
        </h2>
        <span class="skills-group__chevron" aria-hidden="true">
          <Icon name="chevronRight" />
        </span>
      </summary>
      <div class="settings-group">
        <For each={props.group.skills} keyed={(skill) => skill.skillKey}>
          {(skill) => <SkillRow skill={skill()} view={props.view} />}
        </For>
      </div>
    </details>
  );
}

function SkillsToolbar(props: {
  view: SkillsProps;
  statusCounts: Record<SkillsStatusFilter, number>;
  shownCount: number;
}) {
  return (
    <div class="plugins-toolbar plugins-toolbar--fields">
      <SettingsSegmented<SkillsStatusFilter>
        value={props.view.state.skillsStatusFilter}
        ariaLabel={t("skillsPage.title")}
        options={STATUS_TABS.map((tab) => ({
          value: tab.id,
          label: (
            <>
              {t(tab.labelKey)} <span class="settings-count">{props.statusCounts[tab.id]}</span>
            </>
          ),
        }))}
        onChange={props.view.onStatusFilterChange}
      />
      <label class="plugins-field skills-toolbar__search">
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
      <span class="plugins-toolbar__hint">
        {t("skillsPage.shown", { count: String(props.shownCount) })}
      </span>
      <button
        type="button"
        class="btn"
        disabled={skillControlsLocked(props.view) || !props.view.state.connected}
        onClick={() => props.view.onRefresh()}
      >
        {props.view.loading ? t("common.loading") : t("common.refresh")}
      </button>
    </div>
  );
}

function SkillRow(props: { skill: SkillStatusEntry; view: SkillsProps }) {
  const verdict = createMemo(() => verdictForSkill(props.skill, props.view.state.clawhubVerdicts));
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
        <SkillStateStatus skill={props.skill} verdict={verdict()} />
        <Show
          when={props.skill.clawhub?.status === "linked"}
          fallback={
            <Show when={props.skill.clawhub?.status === "invalid"}>
              <SettingsStatus kind="warn" label={t("skillsPage.invalidLink")} />
            </Show>
          }
        >
          <SettingsStatus {...verdictStatus(verdict(), props.view.state.clawhubVerdictsLoading)} />
        </Show>
      </div>
    </div>
  );
}

function SkillDetail(props: { skill: SkillStatusEntry; view: SkillsProps }) {
  const updateLocked = createMemo(() => skillControlsLocked(props.view) || !props.view.canUpdate);
  const active = createMemo(
    () =>
      props.view.state.skillOperation?.kind === "skill" &&
      props.view.state.skillOperation.skillKey === props.skill.skillKey,
  );
  const homepageHref = createMemo(() =>
    resolveSafeExternalUrl(props.skill.homepage ?? "", window.location.href),
  );
  const editValue = createMemo(() => props.view.state.skillEdits[props.skill.skillKey] ?? "");
  const message = createMemo(() => props.view.state.skillMessages[props.skill.skillKey] ?? null);
  const installOption = createMemo(() => {
    const missingBins = new Set([...props.skill.missing.bins, ...props.skill.missing.anyBins]);
    // An installer must provide a currently missing binary, not an unrelated dependency.
    return props.skill.install.find((option) => option.bins.some((bin) => missingBins.has(bin)));
  });
  const missing = createMemo(() => computeSkillMissing(props.skill));
  const reasons = createMemo(() => computeSkillReasons(props.skill));
  const verdict = createMemo(() => verdictForSkill(props.skill, props.view.state.clawhubVerdicts));
  const detailTab = createMemo<SkillDetailTab>(() =>
    props.view.state.skillsDetailTab === "card" && props.skill.skillCard?.present
      ? "card"
      : "overview",
  );
  const hasTabs = createMemo(() => Boolean(props.skill.clawhub || props.skill.skillCard?.present));
  return (
    <SkillReaderDialog
      label={props.skill.name}
      onClose={() => props.view.onDetailClose()}
      title={
        <div
          class="exec-approval-title"
          style={{ display: "flex", "align-items": "center", gap: "8px" }}
        >
          <span
            class={[
              "statusDot",
              props.skill.disabled ? "muted" : isSkillAvailable(props.skill) ? "ok" : "warn",
            ]}
          />
          <Show when={props.skill.emoji}>
            {(emoji) => <span style={{ "font-size": "18px" }}>{emoji()}</span>}
          </Show>
          <span>{props.skill.name}</span>
        </div>
      }
    >
      <div class="skill-reader-dialog__body" style={{ display: "grid", gap: "var(--space-4)" }}>
        <div>
          <div style={{ "font-size": "14px", "line-height": "1.5", color: "var(--text)" }}>
            {props.skill.description}
          </div>
          <LitContent
            render={() =>
              renderSkillStatusChips({
                skill: props.skill,
                showBundledBadge: props.skill.bundled && props.skill.source !== "openclaw-bundled",
              })
            }
          />
        </div>
        <Show when={hasTabs()}>
          <LitContent
            render={() =>
              renderHubTabs({
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
                onSelect: props.view.onDetailTabChange,
              })
            }
          />
        </Show>
        <div
          id="skill-detail-panel"
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
          <div
            class="callout"
            style={{
              "border-color": "var(--warn-subtle)",
              background: "var(--warn-subtle)",
              color: "var(--warn)",
            }}
          >
            <div style={{ "font-weight": "600", "margin-bottom": "4px" }}>
              {t("skillsPage.missingRequirements")}
            </div>
            <div>{missing().join(", ")}</div>
          </div>
        </Show>
        <Show when={reasons().length > 0}>
          <div class="muted" style={{ "font-size": "13px" }}>
            {t("skillsPage.reason", { reasons: reasons().join(", ") })}
          </div>
        </Show>
        <div style={{ display: "flex", "align-items": "center", gap: "12px" }}>
          <SettingsToggle
            checked={!props.skill.disabled}
            disabled={updateLocked()}
            ariaLabel={props.skill.name}
            onChange={() => props.view.onToggle(props.skill.skillKey, props.skill.disabled)}
          />
          <span style={{ "font-size": "13px", "font-weight": "500" }}>
            {props.skill.disabled ? t("skillsPage.disabled") : t("skillsPage.enabled")}
          </span>
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
        </div>
        <Show when={message()}>
          {(value) => (
            <div
              class={["callout", value().kind === "error" ? "danger" : "success"]}
              role={value().kind === "error" ? "alert" : "status"}
            >
              {formatUiExternalText(value().message)}
            </div>
          )}
        </Show>
        <Show when={props.skill.primaryEnv}>
          <div style={{ display: "grid", gap: "8px" }}>
            <label class="field">
              <span>
                {t("skillsPage.apiKey")}{" "}
                <span class="muted" style={{ "font-weight": "normal", "font-size": "0.88em" }}>
                  ({props.skill.primaryEnv})
                </span>
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
                <div class="muted" style={{ "font-size": "13px" }}>
                  {t("skillsPage.getKey")}{" "}
                  <a href={href()} target="_blank" rel="noopener noreferrer">
                    {props.skill.homepage}
                  </a>
                </div>
              )}
            </Show>
            <button
              class="btn primary"
              disabled={updateLocked() || !editValue().trim()}
              onClick={() => props.view.onSaveKey(props.skill.skillKey)}
            >
              {t("skillsPage.saveKey")}
            </button>
          </div>
        </Show>
        <div
          style={{
            "border-top": "1px solid var(--border)",
            "padding-top": "12px",
            display: "grid",
            gap: "6px",
            "font-size": "12px",
            color: "var(--muted)",
          }}
        >
          <div>
            <span style={{ "font-weight": "600" }}>{t("skillsPage.source")}</span>{" "}
            {props.skill.source}
          </div>
          <div style={{ "font-family": "var(--mono)", "word-break": "break-all" }}>
            {props.skill.filePath}
          </div>
          <Show when={homepageHref()}>
            {(href) => (
              <div>
                <a href={href()} target="_blank" rel="noopener noreferrer">
                  {props.skill.homepage}
                </a>
              </div>
            )}
          </Show>
        </div>
      </div>
    </SkillReaderDialog>
  );
}

function InstalledClawHubOverview(props: {
  skill: SkillStatusEntry;
  view: SkillsProps;
  verdict: ClawHubSkillSecurityVerdict | null;
}) {
  const link = createMemo(() => props.skill.clawhub);
  const invalidReason = createMemo(() => {
    const value = link();
    return value?.status === "invalid" ? value.reason : null;
  });
  const installedRef = createMemo(() => {
    const value = link();
    return value?.status === "linked"
      ? `${value.ownerHandle ? `@${value.ownerHandle}/` : ""}${value.slug}@${value.installedVersion}`
      : "";
  });
  const auditHref = createMemo(() =>
    resolveSafeExternalUrl(props.verdict?.securityAuditUrl ?? "", window.location.href),
  );
  const feedback = createMemo(
    () =>
      props.view.state.clawhubVerdictsError ||
      (props.verdict?.reasons?.length
        ? formatUiExternalText(props.verdict.reasons.join(", "))
        : null),
  );
  const status = createMemo(() =>
    verdictStatus(props.verdict, props.view.state.clawhubVerdictsLoading),
  );
  return (
    <Show when={link()}>
      {(current) => (
        <Show
          when={current().status !== "invalid"}
          fallback={
            <div class="callout danger">
              <div style={{ "font-weight": "600", "margin-bottom": "4px" }}>
                {t("skillsPage.invalidLink")}
              </div>
              <div>{formatUiExternalText(invalidReason() ?? "")}</div>
            </div>
          }
        >
          <div
            class="callout"
            style={{
              display: "grid",
              gap: "8px",
              "border-color": "var(--border)",
              background: "var(--panel-strong)",
            }}
          >
            <div
              style={{ display: "flex", "align-items": "center", gap: "8px", "flex-wrap": "wrap" }}
            >
              <span class={["chip", status().chipClass]}>{status().label}</span>
              <span class="muted" style={{ "font-size": "12px" }}>
                {installedRef()}
              </span>
              <Show when={props.view.state.clawhubVerdictsLoading && props.verdict}>
                <span class="muted">{t("skillsPage.refreshing")}</span>
              </Show>
            </div>
            <Show when={feedback()}>
              {(value) => (
                <div class="muted" style={{ "font-size": "13px" }}>
                  {value()}
                </div>
              )}
            </Show>
            <Show when={auditHref()}>
              {(href) => (
                <div style={{ "font-size": "13px" }}>
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
  const content = createMemo(() => props.view.state.skillCardContents[props.skill.skillKey]);
  const error = createMemo(() => props.view.state.skillCardErrors[props.skill.skillKey]);
  return (
    <Show when={props.skill.skillCard?.present}>
      <Show
        when={content() !== undefined}
        fallback={
          <Show
            when={error()}
            fallback={
              <div class="muted" role="status" style={{ "font-size": "13px" }}>
                {props.view.state.skillCardLoadingKey === props.skill.skillKey
                  ? t("skillsPage.loadingSkillCard")
                  : t("skillsPage.skillCardNotLoaded")}
              </div>
            }
          >
            {(value) => (
              <div class="callout danger" role="alert">
                {value()}
              </div>
            )}
          </Show>
        }
      >
        <MarkdownContent
          class="sidebar-markdown"
          style={{ "max-width": "100%", "overflow-wrap": "anywhere" }}
          onClick={handleMarkdownCodeBlockClick}
          content={content() ?? ""}
        />
      </Show>
    </Show>
  );
}
