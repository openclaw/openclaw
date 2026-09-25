import { normalizeLowercaseStringOrEmpty } from "@openclaw/normalization-core/string-coerce";
import { html, nothing } from "lit";
import { repeat } from "lit/directives/repeat.js";
import { unsafeHTML } from "lit/directives/unsafe-html.js";
import type { SkillStatusEntry } from "../../api/types.ts";
import { renderHubTabs } from "../../components/hub-tabs.ts";
import { icons } from "../../components/icons.ts";
import { handleMarkdownCodeBlockClick } from "../../components/markdown-code-blocks.ts";
import "../../components/modal-dialog.ts";
import { toSanitizedMarkdownHtml } from "../../components/markdown.ts";
import {
  renderSettingsEmpty,
  renderSettingsPage,
  renderSettingsSegmented,
  renderSettingsStatus,
  renderSettingsToggle,
} from "../../components/settings-ui.ts";
import { t } from "../../i18n/index.ts";
import { registerSkillLibraryEnglish } from "../../i18n/locales/en-skill-library.ts";
import { registerSkillsBrowserEnglish } from "../../i18n/locales/en-skills-browser.ts";
import { formatUiExternalText } from "../../lib/format-error.ts";
import { clampText } from "../../lib/format.ts";
import { resolveSafeExternalUrl } from "../../lib/open-external-url.ts";
import "../../styles/plugins.css";
import "../../styles/sidebar-markdown.css";
import { groupSkills, type SkillGroup } from "../../lib/skills-grouping.ts";
import {
  computeSkillMissing,
  computeSkillReasons,
  isSkillAvailable,
  renderSkillStatusChips,
} from "../../lib/skills-shared.ts";
import type { ClawHubSkillSecurityVerdict } from "../../lib/skills/index.ts";
import { renderSkillDiscovery } from "./discovery-view.ts";
import { renderSkillStateStatus, verdictForSkill } from "./skill-status.ts";
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

function verdictStatus(
  verdict: ClawHubSkillSecurityVerdict | null | undefined,
  loading: boolean,
): { label: string; kind: "ok" | "warn" | "muted"; chipClass: string } {
  if (!verdict) {
    return loading
      ? { label: t("skillsPage.refreshing"), kind: "muted", chipClass: "chip" }
      : { label: t("skillsPage.verdict.unavailable"), kind: "warn", chipClass: "chip-warn" };
  }
  const status = verdict.securityStatus?.trim() || null;
  if (verdict.ok && verdict.decision === "pass") {
    return {
      label: status === "clean" || !status ? t("skillsPage.verdict.clean") : status,
      kind: "ok",
      chipClass: "chip-ok",
    };
  }
  if (status === "pending" || status === "not-run") {
    return { label: t("skillsPage.verdict.pending"), kind: "muted", chipClass: "chip" };
  }
  const label =
    status === "malicious"
      ? t("skillsPage.verdict.blocked")
      : status === "suspicious"
        ? t("skillsPage.verdict.review")
        : t("skillsPage.verdict.unavailable");
  return { label, kind: "warn", chipClass: "chip-warn" };
}

function skillControlsLocked(props: SkillsProps): boolean {
  return props.loading || props.state.skillOperation !== null;
}

function skillInstallLocked(props: SkillsProps): boolean {
  return skillControlsLocked(props) || !props.canInstall;
}

export function renderSkills(props: SkillsProps) {
  const { state } = props;
  const skills = state.skillsReport?.skills ?? [];

  const statusCounts: Record<SkillsStatusFilter, number> = {
    all: skills.length,
    ready: 0,
    "needs-setup": 0,
    disabled: 0,
  };
  for (const skill of skills) {
    statusCounts[skillStatus(skill)]++;
  }

  const afterStatus =
    state.skillsStatusFilter === "all"
      ? skills
      : skills.filter((skill) => skillStatus(skill) === state.skillsStatusFilter);

  const filter = normalizeLowercaseStringOrEmpty(state.skillsFilter);
  const filtered = filter
    ? afterStatus.filter((skill) =>
        normalizeLowercaseStringOrEmpty(
          [skill.name, skill.description, skill.source].join(" "),
        ).includes(filter),
      )
    : afterStatus;
  const groups = groupSkills(filtered);

  const detailSkill = state.skillsDetailKey
    ? (skills.find((s) => s.skillKey === state.skillsDetailKey) ?? null)
    : null;

  return html`
    ${renderSettingsPage(
      props.surface === "discovery"
        ? html` ${renderSkillDiscovery(props)} ${props.library ?? nothing} `
        : html`
            ${props.library ?? nothing}
            ${
              props.showInventory === false
                ? nothing
                : renderSkillsToolbar(props, statusCounts, filtered.length)
            }
            ${
              props.error
                ? html`<div class="callout danger" role="alert">${props.error}</div>`
                : nothing
            }
            ${
              props.showInventory === false
                ? nothing
                : filtered.length === 0
                  ? renderSettingsEmpty(
                      !state.connected && !state.skillsReport
                        ? t("skillsPage.disconnected")
                        : t("skillsPage.empty"),
                    )
                  : repeat(
                      groups,
                      (group) => group.id,
                      (group) => renderSkillGroup(group, props),
                    )
            }
          `,
      { wide: true, carapace: props.surface === "discovery" },
    )}
    ${detailSkill ? renderSkillDetail(detailSkill, props) : nothing}
    ${state.clawhubDetailRef ? renderClawHubDetailDialog(props) : nothing}
  `;
}

function renderSkillGroup(group: SkillGroup, props: SkillsProps) {
  return html`
    <details class="settings-section skills-group" open>
      <summary class="settings-section__header skills-group__summary">
        <h2 class="settings-section__heading">
          ${group.label} <span class="settings-count">${group.skills.length}</span>
        </h2>
        <span class="skills-group__chevron" aria-hidden="true">${icons.chevronRight}</span>
      </summary>
      <div class="settings-group">
        ${repeat(
          group.skills,
          (skill) => skill.skillKey,
          (skill) => renderSkill(skill, props),
        )}
      </div>
    </details>
  `;
}

function renderSkillsToolbar(
  props: SkillsProps,
  statusCounts: Record<SkillsStatusFilter, number>,
  shownCount: number,
) {
  return html` <div class="plugins-toolbar plugins-toolbar--fields">
    ${renderSettingsSegmented<SkillsStatusFilter>({
      value: props.state.skillsStatusFilter,
      ariaLabel: t("skillsPage.title"),
      options: STATUS_TABS.map((tab) => ({
        value: tab.id,
        label: html`${t(tab.labelKey)} <span class="settings-count">${statusCounts[tab.id]}</span>`,
      })),
      onChange: props.onStatusFilterChange,
    })}
    <label class="plugins-field skills-toolbar__search">
      <span>${t("common.search")}</span>
      <input
        class="settings-input"
        .value=${props.state.skillsFilter}
        @input=${(e: Event) => props.onFilterChange((e.target as HTMLInputElement).value)}
        placeholder=${t("skillsPage.filterPlaceholder")}
        autocomplete="off"
        name="skills-filter"
      />
    </label>
    <span class="plugins-toolbar__hint"
      >${t("skillsPage.shown", { count: String(shownCount) })}</span
    >
    <button
      type="button"
      class="btn"
      ?disabled=${skillControlsLocked(props) || !props.state.connected}
      @click=${props.onRefresh}
    >
      ${props.loading ? t("common.loading") : t("common.refresh")}
    </button>
  </div>`;
}

function renderClawHubDetailDialog(props: SkillsProps) {
  const { state } = props;
  const detail = state.clawhubDetail;
  const skillIconUrl = detail?.skill?.icon ? state.clawhubIconUrls?.[detail.skill.icon] : undefined;
  const profileImageUrl =
    skillIconUrl || !detail?.owner?.image ? undefined : state.clawhubIconUrls?.[detail.owner.image];
  const detailImageUrl = skillIconUrl ?? profileImageUrl;

  return html`
    <openclaw-modal-dialog
      label=${detail?.skill?.displayName ?? state.clawhubDetailRef ?? t("skillsPage.notFound")}
      style="--openclaw-modal-width: min(1040px, calc(100vw - 32px));"
      @modal-cancel=${props.onClawHubDetailClose}
    >
      <div class="exec-approval-card skill-reader-dialog">
        <div class="exec-approval-header">
          <div class="clawhub-skill-detail__identity">
            ${
              detailImageUrl
                ? html`<img
                    class="clawhub-skill-icon clawhub-skill-icon--detail ${
                      profileImageUrl ? "clawhub-skill-icon--profile" : ""
                    }"
                    src=${detailImageUrl}
                    alt=""
                  />`
                : nothing
            }
            <div class="exec-approval-title">
              ${detail?.skill?.displayName ?? state.clawhubDetailRef}
            </div>
          </div>
          <button
            type="button"
            class="btn btn--icon btn--ghost"
            aria-label=${t("skillsPage.close")}
            @click=${props.onClawHubDetailClose}
          >
            ${icons.x}
          </button>
        </div>
        <div class="skill-reader-dialog__body clawhub-skill-detail__body">
          ${
            state.clawhubDetailLoading
              ? html`<div class="muted" role="status">${t("common.loading")}</div>`
              : state.clawhubDetailError
                ? html`<div class="callout danger skill-reader-dialog__error" role="alert">
                    <span aria-hidden="true">${icons.alertTriangle}</span>
                    <span>${state.clawhubDetailError}</span>
                  </div>`
                : detail?.skill
                  ? html`
                      <div>${detail.skill.summary ?? ""}</div>
                      ${
                        detail.owner?.displayName || detail.latestVersion
                          ? html`<div
                              class="clawhub-skill-detail__meta muted"
                              style="letter-spacing: normal;"
                            >
                              ${
                                detail.owner?.displayName
                                  ? html`${t("skillsPage.by")}
                                    ${detail.owner.displayName}${
                                      detail.owner.handle
                                        ? html` (@${detail.owner.handle})`
                                        : nothing
                                    }`
                                  : nothing
                              }
                              ${detail.owner?.displayName && detail.latestVersion ? " · " : nothing}
                              ${
                                detail.latestVersion
                                  ? t("skillsPage.latest", {
                                      version: detail.latestVersion.version,
                                    })
                                  : nothing
                              }
                            </div>`
                          : nothing
                      }
                      ${
                        detail.latestVersion?.changelog
                          ? html`<article class="clawhub-skill-detail__changelog sidebar-markdown">
                              ${unsafeHTML(
                                toSanitizedMarkdownHtml(detail.latestVersion.changelog, {
                                  codeBlockChrome: "none",
                                  mode: "document",
                                }),
                              )}
                            </article>`
                          : nothing
                      }
                      ${
                        detail.metadata?.os
                          ? html`<div class="clawhub-skill-detail__meta muted">
                              ${t("skillsPage.platforms", { platforms: detail.metadata.os.join(", ") })}
                            </div>`
                          : nothing
                      }
                      <div class="exec-approval-actions" style="margin-top: 0;">
                        <button
                          class="btn primary"
                          ?disabled=${skillInstallLocked(props)}
                          @click=${() => {
                            if (state.clawhubDetailRef) {
                              props.onClawHubInstall(state.clawhubDetailRef);
                            }
                          }}
                        >
                          ${
                            state.skillOperation?.kind === "clawhub" &&
                            state.skillOperation.ref === (state.clawhubDetailRef ?? "")
                              ? t("skillsPage.installing")
                              : props.showInventory === false
                                ? t("skillLibrary.import")
                                : t("skillsPage.installNamed", { name: detail.skill.displayName })
                          }
                        </button>
                      </div>
                    `
                  : html`<div class="muted" role="status">${t("skillsPage.notFound")}</div>`
          }
        </div>
      </div>
    </openclaw-modal-dialog>
  `;
}

function renderSkill(skill: SkillStatusEntry, props: SkillsProps) {
  const verdict = verdictForSkill(skill, props.state.clawhubVerdicts);

  return html`
    <div class="settings-row plugins-item plugins-item--clickable">
      <button
        type="button"
        class="settings-row__text plugins-item__detail-button"
        aria-label=${t("skillsPage.openDetails", { name: skill.name })}
        @click=${() => props.onDetailOpen(skill.skillKey)}
      >
        <span class="settings-row__title">
          ${skill.emoji ? html`<span>${skill.emoji}</span> ` : nothing}${skill.name}
        </span>
        <span class="settings-row__desc">${clampText(skill.description, 140)}</span>
      </button>
      <div class="settings-row__control">
        ${renderSkillStateStatus(skill, verdict)}
        ${
          skill.clawhub?.status === "linked"
            ? renderSettingsStatus(verdictStatus(verdict, props.state.clawhubVerdictsLoading))
            : skill.clawhub?.status === "invalid"
              ? renderSettingsStatus({ kind: "warn", label: t("skillsPage.invalidLink") })
              : nothing
        }
      </div>
    </div>
  `;
}

function renderSkillDetail(skill: SkillStatusEntry, props: SkillsProps) {
  const { state } = props;
  const updateLocked = skillControlsLocked(props) || !props.canUpdate;
  const installLocked = skillInstallLocked(props);
  const active =
    state.skillOperation?.kind === "skill" && state.skillOperation.skillKey === skill.skillKey;
  const homepageHref = resolveSafeExternalUrl(skill.homepage ?? "", window.location.href);
  const editValue = state.skillEdits[skill.skillKey] ?? "";
  const message = state.skillMessages[skill.skillKey] ?? null;
  const missingBins = new Set([...skill.missing.bins, ...skill.missing.anyBins]);
  // An installer must provide a currently missing binary, not an unrelated dependency.
  const installOption = skill.install.find((option) =>
    option.bins.some((bin) => missingBins.has(bin)),
  );
  const showBundledBadge = skill.bundled && skill.source !== "openclaw-bundled";
  const missing = computeSkillMissing(skill);
  const reasons = computeSkillReasons(skill);
  const verdict = verdictForSkill(skill, state.clawhubVerdicts);
  const detailTab: SkillDetailTab =
    state.skillsDetailTab === "card" && skill.skillCard?.present ? "card" : "overview";

  return html`
    <openclaw-modal-dialog
      label=${skill.name}
      style="--openclaw-modal-width: min(1040px, calc(100vw - 32px));"
      @modal-cancel=${props.onDetailClose}
    >
      <div class="exec-approval-card skill-reader-dialog">
        <div class="exec-approval-header">
          <div class="exec-approval-title" style="display: flex; align-items: center; gap: 8px;">
            <span
              class="statusDot ${skill.disabled ? "muted" : isSkillAvailable(skill) ? "ok" : "warn"}"
            ></span>
            ${skill.emoji ? html`<span style="font-size: 18px;">${skill.emoji}</span>` : nothing}
            <span>${skill.name}</span>
          </div>
          <button
            type="button"
            class="btn btn--icon btn--ghost"
            aria-label=${t("skillsPage.close")}
            @click=${props.onDetailClose}
          >
            ${icons.x}
          </button>
        </div>
        <div class="skill-reader-dialog__body" style="display: grid; gap: var(--space-4);">
          <div>
            <div style="font-size: 14px; line-height: 1.5; color: var(--text);">
              ${skill.description}
            </div>
            ${renderSkillStatusChips({ skill, showBundledBadge })}
          </div>

          ${
            skill.clawhub || skill.skillCard?.present
              ? html`
                  ${renderHubTabs({
                    id: "skill-detail",
                    active: detailTab,
                    tabs: [
                      { value: "overview", label: t("skillsPage.overview") },
                      ...(skill.skillCard?.present
                        ? [{ value: "card" as const, label: t("skillsPage.skillCard") }]
                        : []),
                    ],
                    ariaLabel: skill.name,
                    panelId: "skill-detail-panel",
                    variant: "sub",
                    onSelect: props.onDetailTabChange,
                  })}
                `
              : nothing
          }
          <div
            id="skill-detail-panel"
            role=${skill.clawhub || skill.skillCard?.present ? "tabpanel" : nothing}
            aria-labelledby=${
              skill.clawhub || skill.skillCard?.present ? `skill-detail-tab-${detailTab}` : nothing
            }
          >
            ${
              detailTab === "overview"
                ? renderInstalledClawHubOverview(skill, props, verdict)
                : renderInstalledSkillCard(skill, props)
            }
          </div>
          ${
            missing.length > 0
              ? html`
                  <div
                    class="callout"
                    style="border-color: var(--warn-subtle); background: var(--warn-subtle); color: var(--warn);"
                  >
                    <div style="font-weight: 600; margin-bottom: 4px;">
                      ${t("skillsPage.missingRequirements")}
                    </div>
                    <div>${missing.join(", ")}</div>
                  </div>
                `
              : nothing
          }
          ${
            reasons.length > 0
              ? html`
                  <div class="muted" style="font-size: 13px;">
                    ${t("skillsPage.reason", { reasons: reasons.join(", ") })}
                  </div>
                `
              : nothing
          }

          <div style="display: flex; align-items: center; gap: 12px;">
            ${renderSettingsToggle({
              checked: !skill.disabled,
              disabled: updateLocked,
              ariaLabel: skill.name,
              onChange: () => props.onToggle(skill.skillKey, skill.disabled),
            })}
            <span style="font-size: 13px; font-weight: 500;">
              ${skill.disabled ? t("skillsPage.disabled") : t("skillsPage.enabled")}
            </span>
            ${
              installOption
                ? html`<button
                    class="btn"
                    ?disabled=${installLocked}
                    @click=${() => props.onInstall(skill.skillKey, skill.name, installOption.id)}
                  >
                    ${active ? t("skillsPage.installing") : installOption.label}
                  </button>`
                : nothing
            }
          </div>

          ${
            message
              ? html`<div
                  class="callout ${message.kind === "error" ? "danger" : "success"}"
                  role=${message.kind === "error" ? "alert" : "status"}
                >
                  ${formatUiExternalText(message.message)}
                </div>`
              : nothing
          }
          ${
            skill.primaryEnv
              ? html`
                  <div style="display: grid; gap: 8px;">
                    <label class="field">
                      <span
                        >${t("skillsPage.apiKey")}
                        <span class="muted" style="font-weight: normal; font-size: 0.88em;"
                          >(${skill.primaryEnv})</span
                        ></span
                      >
                      <input
                        type="password"
                        required
                        ?disabled=${updateLocked}
                        .value=${editValue}
                        @input=${(e: Event) =>
                          props.onEdit(skill.skillKey, (e.target as HTMLInputElement).value)}
                      />
                    </label>
                    ${
                      homepageHref
                        ? html`<div class="muted" style="font-size: 13px;">
                            ${t("skillsPage.getKey")}
                            <a href="${homepageHref}" target="_blank" rel="noopener noreferrer"
                              >${skill.homepage}</a
                            >
                          </div>`
                        : nothing
                    }
                    <button
                      class="btn primary"
                      ?disabled=${updateLocked || !editValue.trim()}
                      @click=${() => props.onSaveKey(skill.skillKey)}
                    >
                      ${t("skillsPage.saveKey")}
                    </button>
                  </div>
                `
              : nothing
          }

          <div
            style="border-top: 1px solid var(--border); padding-top: 12px; display: grid; gap: 6px; font-size: 12px; color: var(--muted);"
          >
            <div>
              <span style="font-weight: 600;">${t("skillsPage.source")}</span> ${skill.source}
            </div>
            <div style="font-family: var(--mono); word-break: break-all;">${skill.filePath}</div>
            ${
              homepageHref
                ? html`<div>
                    <a href="${homepageHref}" target="_blank" rel="noopener noreferrer"
                      >${skill.homepage}</a
                    >
                  </div>`
                : nothing
            }
          </div>
        </div>
      </div>
    </openclaw-modal-dialog>
  `;
}

function renderInstalledClawHubOverview(
  skill: SkillStatusEntry,
  props: SkillsProps,
  verdict: ClawHubSkillSecurityVerdict | null,
) {
  const link = skill.clawhub;
  if (!link) {
    return nothing;
  }
  if (link.status === "invalid") {
    return html`<div class="callout danger">
      <div style="font-weight: 600; margin-bottom: 4px;">${t("skillsPage.invalidLink")}</div>
      <div>${formatUiExternalText(link.reason)}</div>
    </div>`;
  }
  const auditHref = resolveSafeExternalUrl(verdict?.securityAuditUrl ?? "", window.location.href);
  const reasonText = verdict?.reasons?.length
    ? formatUiExternalText(verdict.reasons.join(", "))
    : null;
  const status = verdictStatus(verdict, props.state.clawhubVerdictsLoading);
  const installedRef = `${link.ownerHandle ? `@${link.ownerHandle}/` : ""}${link.slug}@${link.installedVersion}`;
  return html`
    <div
      class="callout"
      style="display: grid; gap: 8px; border-color: var(--border); background: var(--panel-strong);"
    >
      <div style="display: flex; align-items: center; gap: 8px; flex-wrap: wrap;">
        <span class="chip ${status.chipClass}">${status.label}</span>
        <span class="muted" style="font-size: 12px;">${installedRef}</span>
        ${
          props.state.clawhubVerdictsLoading && verdict
            ? html`<span class="muted">${t("skillsPage.refreshing")}</span>`
            : nothing
        }
      </div>
      ${
        props.state.clawhubVerdictsError
          ? html`<div class="muted" style="font-size: 13px;">
              ${props.state.clawhubVerdictsError}
            </div>`
          : reasonText
            ? html`<div class="muted" style="font-size: 13px;">${reasonText}</div>`
            : nothing
      }
      ${
        auditHref
          ? html`<div style="font-size: 13px;">
              <a href="${auditHref}" target="_blank" rel="noopener noreferrer"
                >${t("skillsPage.fullSecurityReport")}</a
              >
            </div>`
          : nothing
      }
    </div>
  `;
}

function renderInstalledSkillCard(skill: SkillStatusEntry, props: SkillsProps) {
  const card = skill.skillCard;
  if (!card?.present) {
    return nothing;
  }
  const content = props.state.skillCardContents[skill.skillKey];
  if (content === undefined) {
    const error = props.state.skillCardErrors[skill.skillKey];
    if (error) {
      return html`<div class="callout danger" role="alert">${error}</div>`;
    }
    return html`<div class="muted" role="status" style="font-size: 13px;">
      ${
        props.state.skillCardLoadingKey === skill.skillKey
          ? t("skillsPage.loadingSkillCard")
          : t("skillsPage.skillCardNotLoaded")
      }
    </div>`;
  }
  return html`
    <article
      class="sidebar-markdown"
      style="max-width: 100%; overflow-wrap: anywhere;"
      @click=${handleMarkdownCodeBlockClick}
    >
      ${unsafeHTML(toSanitizedMarkdownHtml(content))}
    </article>
  `;
}
