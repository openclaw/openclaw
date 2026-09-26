import { html, nothing } from "lit";
import {
  createRuntimeToolMatcher,
  createToolPolicyMatcher,
} from "../../../../src/agents/tool-policy-match.js";
import {
  normalizeToolList,
  normalizeToolPolicyName,
  resolveToolProfilePolicy,
} from "../../../../src/agents/tool-policy-shared.js";
import type {
  ToolsCatalogResult,
  ToolsEffectiveEntry,
  ToolsEffectiveResult,
} from "../../api/types.ts";
import {
  renderSettingsEmpty,
  renderSettingsLoadingSkeleton,
  renderSettingsRow,
  renderSettingsSection,
  renderSettingsToggle,
} from "../../components/settings-ui.ts";
import type { GitHubIdentityController } from "../../features/github-connections/github-identity-controller.ts";
import { renderGitHubIdentity } from "../../features/github-connections/github-identity-view.ts";
import { t } from "../../i18n/index.ts";
import { registerSettingsEnglish } from "../../i18n/locales/en-settings.ts";
import { resolveAgentConfig } from "../../lib/agents/display.ts";
import {
  type AgentToolEntry,
  type AgentToolSection,
  resolveToolProfileOptions,
  resolveToolSections,
} from "../../lib/agents/tool-catalog.ts";
import { formatUiExternalText } from "../../lib/format-error.ts";
import { resolveScrollBehavior } from "../../lib/scroll-behavior.ts";
import {
  resolveToolAvailability,
  renderToolPolicyDetails,
  resolveToolAccessView,
} from "./tool-access-diagnostics.ts";

registerSettingsEnglish();

function renderToolMetaBadges(labels: string[]) {
  if (labels.length === 0) {
    return nothing;
  }
  return html`
    <div class="agent-tool-badges">
      ${labels.map((label) => html`<span class="settings-row__value">${label}</span>`)}
    </div>
  `;
}

function buildRowStatusBadges(
  section: AgentToolSection,
  tool: AgentToolEntry,
  activeEntry: ToolsEffectiveEntry | null,
): string[] {
  const source = tool.source ?? section.source;
  const pluginId = tool.pluginId ?? section.pluginId;
  const badges: string[] = [];
  if (activeEntry && !activeEntry.deniedBySession) {
    badges.push(t("agentTools.inPreview"));
  }
  if (source === "plugin" && pluginId) {
    badges.push(t("agentTools.plugin", { id: pluginId }));
  } else if (source === "core") {
    badges.push(t("agentTools.builtIn"));
  }
  if (tool.optional) {
    badges.push(t("agentTools.optional"));
  }
  return badges;
}

function formatToolPolicyLabels(params: {
  allowed: boolean;
  baseAllowed: boolean;
  denied: boolean;
}) {
  const [state, summary]: [string, string] = params.denied
    ? ["agentTools.disabledByOverride", "agentTools.overrideOff"]
    : params.allowed
      ? params.baseAllowed
        ? ["agentTools.enabledByProfile", "agentTools.enabled"]
        : ["agentTools.enabledByOverride", "agentTools.overrideOn"]
      : ["agentTools.notIncluded", "agentTools.profileOff"];
  return { state: t(state), summary: t(summary) };
}

function formatToolSourceLabel(section: AgentToolSection, tool: AgentToolEntry) {
  const source = tool.source ?? section.source;
  const pluginId = tool.pluginId ?? section.pluginId;
  if (source === "plugin" && pluginId) {
    return t("agentTools.plugin", { id: pluginId });
  }
  return t("agentTools.builtIn");
}

function toToolAnchorId(toolId: string) {
  const safe = normalizeToolPolicyName(toolId).replace(/[^a-z0-9_-]+/g, "-");
  return `agent-tool-${safe}`;
}

const MAX_RUNTIME_TOOL_CHIPS = 12;

function handleToolGroupToggle(event: Event) {
  const group = event.currentTarget;
  if (!(group instanceof HTMLDetailsElement) || group.open) {
    return;
  }
  for (const tool of group.querySelectorAll<HTMLDetailsElement>(".agent-tool-card[open]")) {
    tool.open = false;
  }
}

function handleRuntimeToolJump(event: Event, anchorId: string) {
  const target = document.getElementById(anchorId);
  if (!(target instanceof HTMLDetailsElement)) {
    return;
  }

  event.preventDefault();
  const parentGroup = target.closest<HTMLDetailsElement>(".agent-tools-group");
  if (parentGroup) {
    parentGroup.open = true;
  }
  target.open = true;

  const nextUrl = new URL(window.location.href);
  nextUrl.hash = anchorId;
  window.history.replaceState(null, "", nextUrl);

  requestAnimationFrame(() => {
    target.scrollIntoView?.({
      block: "center",
      behavior: resolveScrollBehavior(),
    });
    target.querySelector<HTMLElement>("summary")?.focus();
  });
}

function renderEffectiveToolNotices(result: ToolsEffectiveResult | null) {
  const notices = result?.notices ?? [];
  if (notices.length === 0) {
    return nothing;
  }
  return html`
    <div class="agent-tools-notices">
      ${notices.map(
        (notice) => html`
          <div
            class="callout ${notice.severity === "warning" ? "warning" : "info"}"
            style="margin-top: 12px"
          >
            ${formatUiExternalText(notice.message)}
          </div>
        `,
      )}
    </div>
  `;
}

function renderEffectiveToolBadge(tool: {
  source: "core" | "plugin" | "channel" | "mcp";
  pluginId?: string;
  channelId?: string;
}) {
  if (tool.source === "plugin") {
    return tool.pluginId
      ? t("agentTools.plugin", { id: tool.pluginId })
      : t("agentTools.pluginSource");
  }
  if (tool.source === "channel") {
    return tool.channelId
      ? t("agentTools.channelSource", { id: tool.channelId })
      : t("agentTools.channel");
  }
  if (tool.source === "mcp") {
    return "MCP";
  }
  return t("agentTools.builtIn");
}

export function renderAgentTools(params: {
  agentId: string;
  configForm: Record<string, unknown> | null;
  configLoading: boolean;
  configSaving: boolean;
  configDirty: boolean;
  toolsCatalogLoading: boolean;
  toolsCatalogError: string | null;
  toolsCatalogResult: ToolsCatalogResult | null;
  toolsEffectiveLoading: boolean;
  toolsEffectiveError: string | null;
  toolsEffectiveResult: ToolsEffectiveResult | null;
  runtimeSessionKey: string;
  runtimeSessionMatchesSelectedAgent: boolean;
  canUpdateConfig: boolean;
  githubIdentity: GitHubIdentityController;
  onOpenGitHubConnections: () => void;
  onProfileChange: (agentId: string, profile: string | null, clearAllow: boolean) => void;
  onOverridesChange: (agentId: string, alsoAllow: string[], deny: string[]) => void;
  onConfigReload: () => void;
  onConfigSave: () => void;
}) {
  const config = resolveAgentConfig(params.configForm, params.agentId);
  const agentTools = config.entry?.tools ?? {};
  const globalTools = config.globalTools ?? {};
  const profile = agentTools.profile ?? globalTools.profile ?? "full";
  const profileOptions = resolveToolProfileOptions(params.toolsCatalogResult);
  const toolSections = resolveToolSections(params.toolsCatalogResult);
  const profileSource = agentTools.profile
    ? t("agentTools.profileSourceAgent")
    : globalTools.profile
      ? t("agentTools.profileSourceGlobal")
      : t("agentTools.profileSourceDefault");
  const hasAgentAllow = Array.isArray(agentTools.allow) && agentTools.allow.length > 0;
  const hasGlobalAllow = Array.isArray(globalTools.allow) && globalTools.allow.length > 0;
  const editable =
    params.canUpdateConfig &&
    Boolean(params.configForm) &&
    !params.configLoading &&
    !params.configSaving &&
    !hasAgentAllow &&
    !(params.toolsCatalogLoading && !params.toolsCatalogResult && !params.toolsCatalogError);
  const alsoAllow = hasAgentAllow
    ? []
    : Array.isArray(agentTools.alsoAllow)
      ? agentTools.alsoAllow
      : [];
  const configuredDeny = Array.isArray(agentTools.deny) ? agentTools.deny : [];
  const deny = hasAgentAllow ? [] : configuredDeny;
  const basePolicy = hasAgentAllow
    ? { allow: agentTools.allow ?? [], deny: configuredDeny }
    : resolveToolProfilePolicy(profile);
  const toolIds = toolSections.flatMap((section) => section.tools.map((tool) => tool.id));
  const matchesBase = createToolPolicyMatcher(basePolicy);
  const matchesAllow = createRuntimeToolMatcher(alsoAllow);
  // Write implies patch access only in allow lists; denials match the named tool.
  const matchesDeny = createRuntimeToolMatcher(deny, false);

  const resolveAllowed = (toolId: string) => {
    const baseAllowed = matchesBase(toolId);
    const extraAllowed = matchesAllow(toolId);
    const denied = matchesDeny(toolId);
    const allowed = (baseAllowed || extraAllowed) && !denied;
    return {
      allowed,
      baseAllowed,
      denied,
    };
  };
  const enabledCount = toolIds.filter((toolId) => resolveAllowed(toolId).allowed).length;
  const { previewStatus, previewResult, unverifiedReason, toolAccess, diagnosticMap } =
    resolveToolAccessView(params);
  const effectiveTools = (previewResult?.groups ?? []).flatMap((group) => group.tools);
  const uniqueEffectiveTools = Array.from(
    new Map(
      effectiveTools
        .filter((tool) => !tool.deniedBySession)
        .map((tool) => [normalizeToolPolicyName(tool.id), tool]),
    ).values(),
  );
  const visibleEffectiveTools = uniqueEffectiveTools.slice(0, MAX_RUNTIME_TOOL_CHIPS);
  const hiddenEffectiveToolCount = Math.max(
    0,
    uniqueEffectiveTools.length - visibleEffectiveTools.length,
  );
  const activeToolMap = new Map(
    effectiveTools.map((tool) => [normalizeToolPolicyName(tool.id), tool] as const),
  );
  const activeToolIds = new Set(
    uniqueEffectiveTools.map((tool) => normalizeToolPolicyName(tool.id)),
  );

  const sortSectionTools = (tools: AgentToolEntry[]) =>
    tools.toSorted((left, right) => {
      const leftId = normalizeToolPolicyName(left.id);
      const rightId = normalizeToolPolicyName(right.id);
      const leftActive = activeToolIds.has(leftId) ? 1 : 0;
      const rightActive = activeToolIds.has(rightId) ? 1 : 0;
      if (leftActive !== rightActive) {
        return rightActive - leftActive;
      }
      const leftAllowed = resolveAllowed(left.id).allowed ? 1 : 0;
      const rightAllowed = resolveAllowed(right.id).allowed ? 1 : 0;
      if (leftAllowed !== rightAllowed) {
        return rightAllowed - leftAllowed;
      }
      return left.label.localeCompare(right.label);
    });

  const updateTools = (targetIds: string[], nextEnabled: boolean) => {
    const nextAllow = new Set(normalizeToolList(alsoAllow));
    const nextDeny = new Set(normalizeToolList(deny));
    for (const toolId of targetIds) {
      const baseAllowed = resolveAllowed(toolId).baseAllowed;
      const normalized = normalizeToolPolicyName(toolId);
      if (nextEnabled) {
        nextDeny.delete(normalized);
        if (!baseAllowed) {
          nextAllow.add(normalized);
        }
      } else {
        nextAllow.delete(normalized);
        nextDeny.add(normalized);
      }
    }
    params.onOverridesChange(params.agentId, [...nextAllow], [...nextDeny]);
  };

  const runtimeAvailability = !params.runtimeSessionMatchesSelectedAgent
    ? renderSettingsEmpty(t("agentTools.switchAgent"))
    : params.toolsEffectiveLoading
      ? renderSettingsLoadingSkeleton({ label: t("agentTools.loadingPreview"), rows: 2 })
      : params.toolsEffectiveError
        ? renderSettingsEmpty(t("agentTools.previewError"))
        : !previewResult
          ? renderSettingsEmpty(t("agentTools.previewNotLoaded"))
          : uniqueEffectiveTools.length === 0
            ? renderSettingsEmpty(t("agentTools.emptyPreview"))
            : html`
                <div class="agents-panel-body">
                  <div class="agent-tools-runtime">
                    ${visibleEffectiveTools.map((tool) => {
                      const anchorId = toToolAnchorId(tool.id);
                      return html`
                        <a
                          class="agent-tools-runtime-chip"
                          href="#${anchorId}"
                          @click=${(event: Event) => handleRuntimeToolJump(event, anchorId)}
                        >
                          <span class="mono" translate="no">${tool.label}</span>
                          <span class="agent-tools-runtime-chip__meta"
                            >${renderEffectiveToolBadge(tool)}</span
                          >
                        </a>
                      `;
                    })}
                    ${
                      hiddenEffectiveToolCount > 0
                        ? html`
                            <span
                              class="agent-tools-runtime-chip agent-tools-runtime-chip--more"
                              title=${t("agentTools.morePreviewTitle", {
                                count: String(hiddenEffectiveToolCount),
                              })}
                            >
                              ${t("agentTools.morePreview", {
                                count: String(hiddenEffectiveToolCount),
                              })}
                            </span>
                          `
                        : nothing
                    }
                  </div>
                </div>
              `;

  return html`
    ${
      !params.configForm
        ? html`<div class="callout info">${t("agentTools.loadConfig")}</div>`
        : nothing
    }
    ${
      hasAgentAllow
        ? html`<div class="callout info">${t("agentTools.explicitAllowlist")}</div>`
        : nothing
    }
    ${
      hasGlobalAllow
        ? html`<div class="callout info">${t("agentTools.globalAllowlist")}</div>`
        : nothing
    }
    ${
      params.toolsCatalogError
        ? html`<div class="callout info">${t("agentTools.catalogFallback")}</div>`
        : nothing
    }
    ${renderSettingsSection(
      {
        title: t("agentTools.title"),
        description: html`${t("agentTools.subtitle")}
          <span class="mono"
            >${t("agentTools.enabledSummary", {
              enabled: String(enabledCount),
              total: String(toolIds.length),
            })}</span
          >`,
        actions: html`
          <button
            class="btn btn--sm"
            ?disabled=${!editable}
            @click=${() => updateTools(toolIds, true)}
          >
            ${t("agentTools.enableAll")}
          </button>
          <button
            class="btn btn--sm"
            ?disabled=${!editable}
            @click=${() => updateTools(toolIds, false)}
          >
            ${t("agentTools.disableAll")}
          </button>
          <button
            class="btn btn--sm"
            ?disabled=${params.configLoading}
            @click=${params.onConfigReload}
          >
            ${t("common.reloadConfig")}
          </button>
          <button
            class="btn btn--sm primary"
            ?disabled=${!params.canUpdateConfig || params.configSaving || !params.configDirty}
            @click=${params.onConfigSave}
          >
            ${params.configSaving ? t("common.saving") : t("common.save")}
          </button>
        `,
      },
      html`
        <dl class="settings-kv">
          <dt>${t("agentTools.profile")}</dt>
          <dd><code>${profile}</code></dd>
          <dt>${t("agentTools.source")}</dt>
          <dd>${profileSource}</dd>
          <dt>${t("agentTools.enabled")}</dt>
          <dd><code>${enabledCount}/${toolIds.length}</code></dd>
          <dt>${t("agentTools.listed")}</dt>
          <dd><code>${previewStatus ?? uniqueEffectiveTools.length}</code></dd>
          <dt>${t("agentTools.status")}</dt>
          <dd>
            ${
              params.configSaving
                ? t("agentTools.statusSaving")
                : params.configDirty
                  ? t("agentTools.statusUnsaved")
                  : t("agentTools.statusSaved")
            }
          </dd>
        </dl>
        ${renderSettingsRow({
          title: t("agentTools.quickPresets"),
          stacked: true,
          control: html`
            <div class="agent-tools-buttons">
              ${profileOptions.map(
                (option) => html`
                  <button
                    class="btn btn--sm ${profile === option.id ? "active" : ""}"
                    ?disabled=${!editable}
                    @click=${() => params.onProfileChange(params.agentId, option.id, true)}
                  >
                    ${option.label}
                  </button>
                `,
              )}
              <button
                class="btn btn--sm"
                ?disabled=${!editable}
                @click=${() => params.onProfileChange(params.agentId, null, false)}
              >
                ${t("agentTools.inherit")}
              </button>
            </div>
          `,
        })}
      `,
    )}
    ${renderSettingsSection(
      {
        title: t("agentTools.previewTitle"),
        description: html`${t("agentTools.previewSubtitle")}
          <span class="mono">${params.runtimeSessionKey || t("agentTools.noSession")}</span>`,
      },
      html`${renderEffectiveToolNotices(previewResult)}${runtimeAvailability}`,
    )}
    ${renderGitHubIdentity(params.githubIdentity, params.onOpenGitHubConnections)}
    ${renderSettingsSection(
      { title: t("agentTools.catalogTitle") },
      html`
        ${
          params.toolsCatalogLoading && !params.toolsCatalogResult && !params.toolsCatalogError
            ? renderSettingsLoadingSkeleton({ label: t("agentTools.loadingCatalog") })
            : nothing
        }
        <div
          class="agents-panel-body agent-tools-grid"
          ?hidden=${
            params.toolsCatalogLoading && !params.toolsCatalogResult && !params.toolsCatalogError
          }
        >
          ${toolSections.map((section) => {
            const sortedTools = sortSectionTools(section.tools);
            const enabledSectionCount = section.tools.filter(
              (tool) => resolveAllowed(tool.id).allowed,
            ).length;
            const activeSectionCount = section.tools.filter((tool) =>
              activeToolIds.has(normalizeToolPolicyName(tool.id)),
            ).length;
            const previewTools = sortedTools.slice(0, 4);
            const remainingPreviewCount = Math.max(0, sortedTools.length - previewTools.length);
            return html`
              <details class="agent-tools-group" @toggle=${handleToolGroupToggle}>
                <summary class="agent-tools-group__summary">
                  <span class="agent-tools-group__summary-main">
                    <span class="agent-tools-group__title">
                      ${section.label}
                      ${
                        section.source === "plugin" && section.pluginId
                          ? html`<span class="settings-row__value"
                              >${t("agentTools.plugin", { id: section.pluginId })}</span
                            >`
                          : nothing
                      }
                    </span>
                    <span
                      class="agent-tools-group__preview"
                      aria-label=${t("agentTools.toolPreview")}
                    >
                      ${previewTools.map(
                        (tool) =>
                          html`<span class="mono" translate="no" title=${tool.label}
                            >${tool.label}</span
                          >`,
                      )}
                      ${
                        remainingPreviewCount > 0
                          ? html`<span
                              >${t("agentTools.more", {
                                count: String(remainingPreviewCount),
                              })}</span
                            >`
                          : nothing
                      }
                    </span>
                  </span>
                  <span class="agent-tools-group__counts">
                    <span
                      >${t(
                        section.tools.length === 1 ? "agentTools.toolsOne" : "agentTools.tools",
                        {
                          count: String(section.tools.length),
                        },
                      )}</span
                    >
                    <span
                      >${t(
                        enabledSectionCount === 1
                          ? "agentTools.enabledToolsOne"
                          : "agentTools.enabledTools",
                        { count: String(enabledSectionCount) },
                      )}</span
                    >
                    ${
                      activeSectionCount > 0
                        ? html`<span
                            >${t(
                              activeSectionCount === 1
                                ? "agentTools.listedToolsOne"
                                : "agentTools.listedTools",
                              { count: String(activeSectionCount) },
                            )}</span
                          >`
                        : nothing
                    }
                  </span>
                </summary>
                <div class="agent-tools-list agent-tools-list--stacked">
                  ${sortedTools.map((tool) => {
                    const anchorId = toToolAnchorId(tool.id);
                    const resolved = resolveAllowed(tool.id);
                    const activeEntry = activeToolMap.get(normalizeToolPolicyName(tool.id)) ?? null;
                    const defaultProfiles = tool.defaultProfiles ?? [];
                    const rowBadges = buildRowStatusBadges(section, tool, activeEntry);
                    const policyLabels = formatToolPolicyLabels(resolved);
                    const diagnostic = diagnosticMap.get(normalizeToolPolicyName(tool.id)) ?? null;
                    const { summary: runtimeSummary, reason: availabilityReason } =
                      resolveToolAvailability(
                        diagnostic,
                        activeEntry,
                        unverifiedReason,
                        previewStatus,
                      );
                    return html`
                      <details class="agent-tool-card" id=${anchorId}>
                        <summary class="agent-tool-summary">
                          <div class="agent-tool-summary__main">
                            <div class="agent-tool-summary__title-row">
                              <span class="agent-tool-title mono" translate="no"
                                >${tool.label}</span
                              >
                            </div>
                            <div class="agent-tool-sub">${tool.description}</div>
                          </div>
                          <dl class="agent-tool-summary__facts">
                            <div class="agent-tool-summary__fact">
                              <dt class="label">${t("agentTools.access")}</dt>
                              <dd>${policyLabels.summary}</dd>
                            </div>
                            <div class="agent-tool-summary__fact">
                              <dt class="label">${t("agentTools.previewTitle")}</dt>
                              <dd>
                                ${runtimeSummary}
                                ${availabilityReason ? html`<div class="muted">${availabilityReason}</div>` : nothing}
                              </dd>
                            </div>
                          </dl>
                          <div class="agent-tool-summary__badges">
                            ${renderToolMetaBadges(rowBadges)}
                          </div>
                          <span
                            class="agent-tool-toggle"
                            @click=${(event: Event) => event.stopPropagation()}
                            @keydown=${(event: KeyboardEvent) => event.stopPropagation()}
                          >
                            ${renderSettingsToggle({
                              checked: resolved.allowed,
                              disabled: !editable,
                              ariaLabel: t(
                                resolved.allowed
                                  ? "agentTools.disableNamed"
                                  : "agentTools.enableNamed",
                                { name: tool.label },
                              ),
                              onChange: (checked) => updateTools([tool.id], checked),
                            })}
                          </span>
                        </summary>
                        <div class="agent-tool-details">
                          <div class="agent-tool-details-strip">
                            <div class="agent-tool-detail agent-tool-detail--inline">
                              <div class="label">${t("agentTools.access")}</div>
                              <div>${policyLabels.state}</div>
                            </div>
                            <div class="agent-tool-detail agent-tool-detail--inline">
                              <div class="label">${t("agentTools.source")}</div>
                              <div>${formatToolSourceLabel(section, tool)}</div>
                            </div>
                            ${
                              defaultProfiles.length > 0
                                ? html`
                                    <div class="agent-tool-detail agent-tool-detail--inline">
                                      <div class="label">${t("agentTools.defaultPresets")}</div>
                                      ${renderToolMetaBadges(defaultProfiles)}
                                    </div>
                                  `
                                : nothing
                            }
                            <div class="agent-tool-detail agent-tool-detail--inline">
                              <div class="label">${t("agentTools.previewTitle")}</div>
                              <div>
                                ${
                                  unverifiedReason ??
                                  (activeEntry?.deniedBySession
                                    ? t("agentTools.sessionRestricted")
                                    : activeEntry
                                      ? t("agentTools.previewVia", {
                                          source: renderEffectiveToolBadge(activeEntry),
                                        })
                                      : availabilityReason || runtimeSummary)
                                }
                              </div>
                            </div>
                            <a class="agent-tool-jump" href="#${anchorId}">
                              ${t("agentTools.linkTool")}
                            </a>
                          </div>
                          ${renderToolPolicyDetails(diagnostic, toolAccess)}
                        </div>
                      </details>
                    `;
                  })}
                </div>
              </details>
            `;
          })}
        </div>
      `,
    )}
  `;
}
