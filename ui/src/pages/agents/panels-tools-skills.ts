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
import { renderAgentConfigActions, type AgentConfigActions } from "./config-actions.ts";
import { renderAgentPanelAction, renderAgentPanelFacts } from "./panel-ui.ts";
import { resolveToolAvailability, renderToolPolicyDetails } from "./tool-access-diagnostics.ts";

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

function buildToolPresentation(
  section: AgentToolSection,
  tool: AgentToolEntry,
  activeEntry: ToolsEffectiveEntry | null,
) {
  const source = tool.source ?? section.source;
  const pluginId = tool.pluginId ?? section.pluginId;
  const sourceLabel =
    source === "plugin" && pluginId
      ? t("agentTools.plugin", { id: pluginId })
      : t("agentTools.builtIn");
  const badges: string[] = [];
  if (activeEntry && !activeEntry.deniedBySession) {
    badges.push(t("agentTools.inPreview"));
  }
  if (source === "core" || (source === "plugin" && pluginId)) {
    badges.push(sourceLabel);
  }
  if (tool.optional) {
    badges.push(t("agentTools.optional"));
  }
  return { badges, sourceLabel };
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

export function renderAgentTools(
  params: AgentConfigActions & {
    agentId: string;
    configForm: Record<string, unknown> | null;
    toolsCatalogLoading: boolean;
    toolsCatalogError: string | null;
    toolsCatalogResult: ToolsCatalogResult | null;
    toolsEffectiveLoading: boolean;
    toolsEffectiveError: string | null;
    toolsEffectiveResult: ToolsEffectiveResult | null;
    runtimeSessionKey: string;
    runtimeSessionMatchesSelectedAgent: boolean;
    githubIdentity: GitHubIdentityController;
    onOpenGitHubConnections: () => void;
    onProfileChange: (agentId: string, profile: string | null, clearAllow: boolean) => void;
    onOverridesChange: (agentId: string, alsoAllow: string[], deny: string[]) => void;
  },
) {
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
  const catalogLoading =
    params.toolsCatalogLoading && !params.toolsCatalogResult && !params.toolsCatalogError;
  const editable =
    params.canUpdateConfig &&
    Boolean(params.configForm) &&
    !params.configLoading &&
    !params.configSaving &&
    !hasAgentAllow &&
    !catalogLoading;
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
  const preview = !params.runtimeSessionMatchesSelectedAgent
    ? { status: "otherAgent", empty: "switchAgent" }
    : params.toolsEffectiveLoading
      ? { status: "previewLoading", empty: "loadingPreview" }
      : params.toolsEffectiveError
        ? { status: "previewUnavailable", empty: "previewError" }
        : !params.toolsEffectiveResult
          ? { status: "previewNotLoaded", empty: "previewNotLoaded" }
          : null;
  const previewStatus = preview ? t(`agentTools.${preview.status}`) : null;
  const previewResult = previewStatus ? null : params.toolsEffectiveResult;
  const unverifiedReason =
    previewStatus ?? (params.configDirty ? t("agentTools.unsavedAvailability") : null);
  const toolAccess = unverifiedReason ? null : (previewResult?.toolAccess ?? null);
  const diagnosticMap = new Map(
    toolAccess?.tools.map((tool) => [normalizeToolPolicyName(tool.id), tool] as const),
  );
  const effectiveTools = (previewResult?.groups ?? []).flatMap((group) => group.tools);
  const activeToolMap = new Map<string, ToolsEffectiveEntry>();
  const availableTools = new Map<string, ToolsEffectiveEntry>();
  for (const tool of effectiveTools) {
    const key = normalizeToolPolicyName(tool.id);
    activeToolMap.set(key, tool);
    if (!tool.deniedBySession) {
      availableTools.set(key, tool);
    }
  }
  const uniqueEffectiveTools = [...availableTools.values()];
  const visibleEffectiveTools = uniqueEffectiveTools.slice(0, MAX_RUNTIME_TOOL_CHIPS);
  const hiddenEffectiveToolCount = uniqueEffectiveTools.length - visibleEffectiveTools.length;
  const sortSectionTools = (tools: AgentToolEntry[]) =>
    tools.toSorted(
      (left, right) =>
        Number(availableTools.has(normalizeToolPolicyName(right.id))) -
          Number(availableTools.has(normalizeToolPolicyName(left.id))) ||
        Number(resolveAllowed(right.id).allowed) - Number(resolveAllowed(left.id).allowed) ||
        left.label.localeCompare(right.label),
    );

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

  const runtimeAvailability = preview
    ? preview.status === "previewLoading"
      ? renderSettingsLoadingSkeleton({ label: t(`agentTools.${preview.empty}`), rows: 2 })
      : renderSettingsEmpty(t(`agentTools.${preview.empty}`))
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
    ${(
      [
        [!params.configForm, "agentTools.loadConfig"],
        [hasAgentAllow, "agentTools.explicitAllowlist"],
        [hasGlobalAllow, "agentTools.globalAllowlist"],
        [params.toolsCatalogError, "agentTools.catalogFallback"],
      ] as const
    ).map(([visible, label]) =>
      visible ? html`<div class="callout info">${t(label)}</div>` : nothing,
    )}
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
          ${[true, false].map((enabled) =>
            renderAgentPanelAction(
              t(enabled ? "agentTools.enableAll" : "agentTools.disableAll"),
              !editable,
              () => updateTools(toolIds, enabled),
            ),
          )}
          ${renderAgentConfigActions(params)}
        `,
      },
      html`
        ${renderAgentPanelFacts([
          ["agentTools.profile", html`<code>${profile}</code>`],
          ["agentTools.source", profileSource],
          ["agentTools.enabled", html`<code>${enabledCount}/${toolIds.length}</code>`],
          ["agentTools.listed", html`<code>${previewStatus ?? uniqueEffectiveTools.length}</code>`],
          [
            "agentTools.status",
            t(
              params.configSaving
                ? "agentTools.statusSaving"
                : params.configDirty
                  ? "agentTools.statusUnsaved"
                  : "agentTools.statusSaved",
            ),
          ],
        ])}
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
              ${renderAgentPanelAction(t("agentTools.inherit"), !editable, () => params.onProfileChange(params.agentId, null, false))}
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
          catalogLoading
            ? renderSettingsLoadingSkeleton({ label: t("agentTools.loadingCatalog") })
            : nothing
        }
        <div class="agents-panel-body agent-tools-grid" ?hidden=${catalogLoading}>
          ${toolSections.map((section) => {
            const sortedTools = sortSectionTools(section.tools);
            const enabledSectionCount = section.tools.filter(
              (tool) => resolveAllowed(tool.id).allowed,
            ).length;
            const activeSectionCount = section.tools.filter((tool) =>
              availableTools.has(normalizeToolPolicyName(tool.id)),
            ).length;
            const previewTools = sortedTools.slice(0, 4);
            const remainingPreviewCount = sortedTools.length - previewTools.length;
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
                    ${(
                      [
                        ["tools", section.tools.length],
                        ["enabledTools", enabledSectionCount],
                        ["listedTools", activeSectionCount],
                      ] as const
                    ).map(([label, count]) =>
                      label === "listedTools" && count === 0
                        ? nothing
                        : html`<span
                            >${t(`agentTools.${label}${count === 1 ? "One" : ""}`, {
                              count: String(count),
                            })}</span
                          >`,
                    )}
                  </span>
                </summary>
                <div class="agent-tools-list">
                  ${sortedTools.map((tool) => {
                    const anchorId = toToolAnchorId(tool.id);
                    const resolved = resolveAllowed(tool.id);
                    const activeEntry = activeToolMap.get(normalizeToolPolicyName(tool.id)) ?? null;
                    const defaultProfiles = tool.defaultProfiles ?? [];
                    const { badges, sourceLabel } = buildToolPresentation(
                      section,
                      tool,
                      activeEntry,
                    );
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
                            ${renderToolMetaBadges(badges)}
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
                              <div>${sourceLabel}</div>
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
