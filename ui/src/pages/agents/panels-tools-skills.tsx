import { For, Show, createMemo } from "solid-js";
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
  SettingsSection,
  SettingsRow,
  SettingsToggle,
  SettingsEmpty,
  SettingsLoadingSkeleton,
} from "../../components/solid/settings-ui.tsx";
import type { GitHubIdentityController } from "../../features/github-connections/github-identity-controller.ts";
import { renderGitHubIdentity } from "../../features/github-connections/github-identity-view.ts";
import { registerSettingsEnglish } from "../../i18n/locales/en-settings.ts";
import { resolveAgentConfig } from "../../lib/agents/display.ts";
import {
  type AgentToolEntry,
  type AgentToolSection,
  resolveToolProfileOptions,
  resolveToolSections,
} from "../../lib/agents/tool-catalog.ts";
import { formatUiExternalText } from "../../lib/format-error.ts";
import { t } from "../../lib/reactive/i18n.ts";
import { resolveScrollBehavior } from "../../lib/scroll-behavior.ts";
import { LitContent } from "../../lit/solid-bridge.ts";
import { AgentConfigButtons, type AgentConfigActions } from "./config-actions.tsx";
import { AgentPanelAction, renderAgentPanelFacts } from "./panel-ui.tsx";
import { resolveToolAvailability, renderToolPolicyDetails } from "./tool-access-diagnostics.tsx";

registerSettingsEnglish();

function renderToolMetaBadges(labels: string[]) {
  if (labels.length === 0) {
    return undefined;
  }
  return (
    <div class="agent-tool-badges">
      <For each={labels}>{(label) => <span class="settings-row__value">{label}</span>}</For>
    </div>
  );
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

export function AgentTools(
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
  const config = createMemo(() => resolveAgentConfig(params.configForm, params.agentId));
  const agentTools = () => config().entry?.tools ?? {};
  const globalTools = () => config().globalTools ?? {};
  const profile = () => agentTools().profile ?? globalTools().profile ?? "full";
  const profileOptions = createMemo(() => resolveToolProfileOptions(params.toolsCatalogResult));
  const toolSections = createMemo(() => resolveToolSections(params.toolsCatalogResult));
  const profileSource = () =>
    agentTools().profile
      ? t("agentTools.profileSourceAgent")
      : globalTools().profile
        ? t("agentTools.profileSourceGlobal")
        : t("agentTools.profileSourceDefault");
  const hasAgentAllow = () => {
    const tools = agentTools();
    return Array.isArray(tools.allow) && tools.allow.length > 0;
  };
  const hasGlobalAllow = () => {
    const tools = globalTools();
    return Array.isArray(tools.allow) && tools.allow.length > 0;
  };
  const catalogLoading = () =>
    params.toolsCatalogLoading && !params.toolsCatalogResult && !params.toolsCatalogError;
  const editable = () =>
    params.canUpdateConfig &&
    Boolean(params.configForm) &&
    !params.configLoading &&
    !params.configSaving &&
    !hasAgentAllow() &&
    !catalogLoading();
  const alsoAllow = createMemo(() => {
    const tools = agentTools();
    return hasAgentAllow() ? [] : Array.isArray(tools.alsoAllow) ? tools.alsoAllow : [];
  });
  const configuredDeny = createMemo(() => {
    const tools = agentTools();
    return Array.isArray(tools.deny) ? tools.deny : [];
  });
  const deny = () => (hasAgentAllow() ? [] : configuredDeny());
  const basePolicy = createMemo(() =>
    hasAgentAllow()
      ? { allow: agentTools().allow ?? [], deny: configuredDeny() }
      : resolveToolProfilePolicy(profile()),
  );
  const toolIds = createMemo(() =>
    toolSections().flatMap((section) => section.tools.map((tool) => tool.id)),
  );
  const matchesBase = createMemo(() => createToolPolicyMatcher(basePolicy()));
  const matchesAllow = createMemo(() => createRuntimeToolMatcher(alsoAllow()));
  // Write implies patch access only in allow lists; denials match the named tool.
  const matchesDeny = createMemo(() => createRuntimeToolMatcher(deny(), false));

  const resolveAllowed = (toolId: string) => {
    const baseAllowed = matchesBase()(toolId);
    const extraAllowed = matchesAllow()(toolId);
    const denied = matchesDeny()(toolId);
    const allowed = (baseAllowed || extraAllowed) && !denied;
    return {
      allowed,
      baseAllowed,
      denied,
    };
  };
  const enabledCount = createMemo(
    () => toolIds().filter((toolId) => resolveAllowed(toolId).allowed).length,
  );
  const preview = createMemo(() =>
    !params.runtimeSessionMatchesSelectedAgent
      ? { status: "otherAgent", empty: "switchAgent" }
      : params.toolsEffectiveLoading
        ? { status: "previewLoading", empty: "loadingPreview" }
        : params.toolsEffectiveError
          ? { status: "previewUnavailable", empty: "previewError" }
          : !params.toolsEffectiveResult
            ? { status: "previewNotLoaded", empty: "previewNotLoaded" }
            : null,
  );
  const previewStatus = createMemo(() => {
    const current = preview();
    return current ? t(`agentTools.${current.status}`) : null;
  });
  const previewResult = createMemo(() => (previewStatus() ? null : params.toolsEffectiveResult));
  const unverifiedReason = () =>
    previewStatus() ?? (params.configDirty ? t("agentTools.unsavedAvailability") : null);
  const toolAccess = () => (unverifiedReason() ? null : (previewResult()?.toolAccess ?? null));
  const diagnosticMap = createMemo(
    () =>
      new Map(toolAccess()?.tools.map((tool) => [normalizeToolPolicyName(tool.id), tool] as const)),
  );
  const effectiveTools = createMemo(() =>
    (previewResult()?.groups ?? []).flatMap((group) => group.tools),
  );
  const activeToolMap = createMemo(
    () =>
      new Map(effectiveTools().map((tool) => [normalizeToolPolicyName(tool.id), tool] as const)),
  );
  const availableTools = createMemo(
    () =>
      new Map(
        effectiveTools()
          .filter((tool) => !tool.deniedBySession)
          .map((tool) => [normalizeToolPolicyName(tool.id), tool] as const),
      ),
  );
  const uniqueEffectiveTools = createMemo(() => [...availableTools().values()]);
  const visibleEffectiveTools = createMemo(() =>
    uniqueEffectiveTools().slice(0, MAX_RUNTIME_TOOL_CHIPS),
  );
  const hiddenEffectiveToolCount = () =>
    uniqueEffectiveTools().length - visibleEffectiveTools().length;

  const handleToolsUpdate = (targetIds: string[], nextEnabled: boolean) => {
    const nextAllow = new Set(normalizeToolList(alsoAllow()));
    const nextDeny = new Set(normalizeToolList(deny()));
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

  const runtimeAvailability = createMemo(() => {
    const current = preview();
    return current ? (
      current.status === "previewLoading" ? (
        <SettingsLoadingSkeleton label={t(`agentTools.${current.empty}`)} rows={2} />
      ) : (
        <SettingsEmpty message={t(`agentTools.${current.empty}`)} />
      )
    ) : uniqueEffectiveTools().length === 0 ? (
      <SettingsEmpty message={t("agentTools.emptyPreview")} />
    ) : (
      <div class="agents-panel-body">
        <div class="agent-tools-runtime">
          <For each={visibleEffectiveTools()} keyed={(tool) => tool.id}>
            {(tool) => {
              const anchorId = () => toToolAnchorId(tool().id);
              return (
                <a
                  class="agent-tools-runtime-chip"
                  href={`#${anchorId()}`}
                  onClick={(event: Event) => handleRuntimeToolJump(event, anchorId())}
                >
                  <span class="mono" translate="no">
                    {tool().label}
                  </span>
                  <span class="agent-tools-runtime-chip__meta">
                    {renderEffectiveToolBadge(tool())}
                  </span>
                </a>
              );
            }}
          </For>
          {hiddenEffectiveToolCount() > 0 ? (
            <span
              class="agent-tools-runtime-chip agent-tools-runtime-chip--more"
              title={t("agentTools.morePreviewTitle", {
                count: String(hiddenEffectiveToolCount()),
              })}
            >
              {t("agentTools.morePreview", {
                count: String(hiddenEffectiveToolCount()),
              })}
            </span>
          ) : undefined}
        </div>
      </div>
    );
  });

  return (
    <>
      <For
        each={
          [
            [!params.configForm, "agentTools.loadConfig"],
            [hasAgentAllow(), "agentTools.explicitAllowlist"],
            [hasGlobalAllow(), "agentTools.globalAllowlist"],
            [params.toolsCatalogError, "agentTools.catalogFallback"],
          ] as const
        }
      >
        {(entry) => (entry[0] ? <div class="callout info">{t(entry[1])}</div> : undefined)}
      </For>
      <SettingsSection
        title={t("agentTools.title")}
        description={
          <>
            {t("agentTools.subtitle")}
            <span class="mono">
              {t("agentTools.enabledSummary", {
                enabled: String(enabledCount()),
                total: String(toolIds().length),
              })}
            </span>
          </>
        }
        actions={
          <>
            <For each={[true, false]}>
              {(enabled) => (
                <AgentPanelAction
                  label={t(enabled ? "agentTools.enableAll" : "agentTools.disableAll")}
                  disabled={!editable()}
                  onClick={() => handleToolsUpdate(toolIds(), enabled)}
                />
              )}
            </For>
            <AgentConfigButtons {...params} />
          </>
        }
      >
        {renderAgentPanelFacts([
          ["agentTools.profile", <code>{profile()}</code>],
          ["agentTools.source", profileSource()],
          [
            "agentTools.enabled",
            <code>
              {enabledCount()}/{toolIds().length}
            </code>,
          ],
          ["agentTools.listed", <code>{previewStatus() ?? uniqueEffectiveTools().length}</code>],
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
        <SettingsRow
          title={t("agentTools.quickPresets")}
          stacked
          control={
            <div class="agent-tools-buttons">
              <For each={profileOptions()}>
                {(option) => (
                  <button
                    class={["btn btn--sm", { active: profile() === option.id }]}
                    disabled={!editable()}
                    onClick={() => params.onProfileChange(params.agentId, option.id, true)}
                  >
                    {option.label}
                  </button>
                )}
              </For>
              <AgentPanelAction
                label={t("agentTools.inherit")}
                disabled={!editable()}
                onClick={() => params.onProfileChange(params.agentId, null, false)}
              />
            </div>
          }
        />
      </SettingsSection>
      <SettingsSection
        title={t("agentTools.previewTitle")}
        description={
          <>
            {t("agentTools.previewSubtitle")}
            <span class="mono">{params.runtimeSessionKey || t("agentTools.noSession")}</span>
          </>
        }
      >
        <Show when={previewResult()?.notices?.length}>
          <div class="agent-tools-notices">
            <For each={previewResult()?.notices}>
              {(notice) => (
                <div
                  class={["callout", notice.severity === "warning" ? "warning" : "info"]}
                  style={{ "margin-top": "12px" }}
                >
                  {formatUiExternalText(notice.message)}
                </div>
              )}
            </For>
          </div>
        </Show>
        {runtimeAvailability()}
      </SettingsSection>
      <LitContent
        render={() => renderGitHubIdentity(params.githubIdentity, params.onOpenGitHubConnections)}
      />
      <SettingsSection title={t("agentTools.catalogTitle")}>
        {catalogLoading() ? (
          <SettingsLoadingSkeleton label={t("agentTools.loadingCatalog")} />
        ) : undefined}
        <div class="agents-panel-body agent-tools-grid" hidden={catalogLoading()}>
          <For each={toolSections()} keyed={(section) => section.id}>
            {(section) => {
              const sortedTools = createMemo(() => {
                const ranked = section().tools.map((tool) => ({
                  tool,
                  active: availableTools().has(normalizeToolPolicyName(tool.id)),
                  enabled: resolveAllowed(tool.id).allowed,
                }));
                return ranked
                  .toSorted(
                    (left, right) =>
                      Number(right.active) - Number(left.active) ||
                      Number(right.enabled) - Number(left.enabled) ||
                      left.tool.label.localeCompare(right.tool.label),
                  )
                  .map((entry) => entry.tool);
              });
              const enabledSectionCount = createMemo(
                () => section().tools.filter((tool) => resolveAllowed(tool.id).allowed).length,
              );
              const activeSectionCount = createMemo(
                () =>
                  section().tools.filter((tool) =>
                    availableTools().has(normalizeToolPolicyName(tool.id)),
                  ).length,
              );
              const previewTools = createMemo(() => sortedTools().slice(0, 4));
              const remainingPreviewCount = () => sortedTools().length - previewTools().length;
              return (
                <details class="agent-tools-group" onToggle={handleToolGroupToggle}>
                  <summary class="agent-tools-group__summary">
                    <span class="agent-tools-group__summary-main">
                      <span class="agent-tools-group__title">
                        {section().label}
                        <Show when={section().source === "plugin" && section().pluginId} keyed>
                          {(pluginId) => (
                            <span class="settings-row__value">
                              {t("agentTools.plugin", { id: pluginId })}
                            </span>
                          )}
                        </Show>
                      </span>
                      <span
                        class="agent-tools-group__preview"
                        aria-label={t("agentTools.toolPreview")}
                      >
                        <For each={previewTools()}>
                          {(tool) => (
                            <span class="mono" translate="no" title={tool.label}>
                              {tool.label}
                            </span>
                          )}
                        </For>
                        {remainingPreviewCount() > 0 ? (
                          <span>
                            {t("agentTools.more", {
                              count: String(remainingPreviewCount()),
                            })}
                          </span>
                        ) : undefined}
                      </span>
                    </span>
                    <span class="agent-tools-group__counts">
                      <For
                        each={
                          [
                            ["tools", section().tools.length],
                            ["enabledTools", enabledSectionCount()],
                            ["listedTools", activeSectionCount()],
                          ] as const
                        }
                      >
                        {(entry) =>
                          entry[0] === "listedTools" && entry[1] === 0 ? undefined : (
                            <span>
                              {t(`agentTools.${entry[0]}${entry[1] === 1 ? "One" : ""}`, {
                                count: String(entry[1]),
                              })}
                            </span>
                          )
                        }
                      </For>
                    </span>
                  </summary>
                  <div class="agent-tools-list">
                    <For each={sortedTools()} keyed={(tool) => tool.id}>
                      {(tool) => {
                        const anchorId = () => toToolAnchorId(tool().id);
                        const resolved = createMemo(() => resolveAllowed(tool().id));
                        const activeEntry = createMemo(
                          () => activeToolMap().get(normalizeToolPolicyName(tool().id)) ?? null,
                        );
                        const defaultProfiles = () => tool().defaultProfiles ?? [];
                        const presentation = createMemo(() =>
                          buildToolPresentation(section(), tool(), activeEntry()),
                        );
                        const policyLabels = createMemo(() => formatToolPolicyLabels(resolved()));
                        const diagnostic = createMemo(
                          () => diagnosticMap().get(normalizeToolPolicyName(tool().id)) ?? null,
                        );
                        const availability = createMemo(() =>
                          resolveToolAvailability(
                            diagnostic(),
                            activeEntry(),
                            unverifiedReason(),
                            previewStatus(),
                          ),
                        );
                        const previewLabel = createMemo(() => {
                          const reason = unverifiedReason();
                          if (reason) {
                            return reason;
                          }
                          const entry = activeEntry();
                          return entry?.deniedBySession
                            ? t("agentTools.sessionRestricted")
                            : entry
                              ? t("agentTools.previewVia", {
                                  source: renderEffectiveToolBadge(entry),
                                })
                              : availability().reason || availability().summary;
                        });
                        return (
                          <details class="agent-tool-card" id={anchorId()}>
                            <summary class="agent-tool-summary">
                              <div class="agent-tool-summary__main">
                                <div class="agent-tool-summary__title-row">
                                  <span class="agent-tool-title mono" translate="no">
                                    {tool().label}
                                  </span>
                                </div>
                                <div class="agent-tool-sub">{tool().description}</div>
                              </div>
                              <dl class="agent-tool-summary__facts">
                                <div class="agent-tool-summary__fact">
                                  <dt class="label">{t("agentTools.access")}</dt>
                                  <dd>{policyLabels().summary}</dd>
                                </div>
                                <div class="agent-tool-summary__fact">
                                  <dt class="label">{t("agentTools.previewTitle")}</dt>
                                  <dd>
                                    {availability().summary}
                                    {availability().reason ? (
                                      <div class="muted">{availability().reason}</div>
                                    ) : undefined}
                                  </dd>
                                </div>
                              </dl>
                              <div class="agent-tool-summary__badges">
                                {renderToolMetaBadges(presentation().badges)}
                              </div>
                              <span
                                class="agent-tool-toggle"
                                onClick={(event: Event) => event.stopPropagation()}
                                onKeyDown={(event: KeyboardEvent) => event.stopPropagation()}
                              >
                                <SettingsToggle
                                  checked={resolved().allowed}
                                  disabled={!editable()}
                                  ariaLabel={t(
                                    resolved().allowed
                                      ? "agentTools.disableNamed"
                                      : "agentTools.enableNamed",
                                    { name: tool().label },
                                  )}
                                  onChange={(checked) => handleToolsUpdate([tool().id], checked)}
                                />
                              </span>
                            </summary>
                            <div class="agent-tool-details">
                              <div class="agent-tool-details-strip">
                                <div class="agent-tool-detail agent-tool-detail--inline">
                                  <div class="label">{t("agentTools.access")}</div>
                                  <div>{policyLabels().state}</div>
                                </div>
                                <div class="agent-tool-detail agent-tool-detail--inline">
                                  <div class="label">{t("agentTools.source")}</div>
                                  <div>{presentation().sourceLabel}</div>
                                </div>
                                {defaultProfiles().length > 0 ? (
                                  <div class="agent-tool-detail agent-tool-detail--inline">
                                    <div class="label">{t("agentTools.defaultPresets")}</div>
                                    {renderToolMetaBadges(defaultProfiles())}
                                  </div>
                                ) : undefined}
                                <div class="agent-tool-detail agent-tool-detail--inline">
                                  <div class="label">{t("agentTools.previewTitle")}</div>
                                  <div>{previewLabel()}</div>
                                </div>
                                <a class="agent-tool-jump" href={`#${anchorId()}`}>
                                  {t("agentTools.linkTool")}
                                </a>
                              </div>
                              {renderToolPolicyDetails(diagnostic(), toolAccess())}
                            </div>
                          </details>
                        );
                      }}
                    </For>
                  </div>
                </details>
              );
            }}
          </For>
        </div>
      </SettingsSection>
    </>
  );
}
