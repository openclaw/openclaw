import type { JSX } from "@solidjs/web";
import {
  Errored,
  For,
  Loading,
  Show,
  createMemo,
  createSignal,
  isPending,
  onSettled,
} from "solid-js";
import {
  createRuntimeToolMatcher,
  createToolPolicyMatcher,
} from "../../../../src/agents/tool-policy-match.js";
import {
  normalizeToolList,
  normalizeToolPolicyName,
  resolveToolProfilePolicy,
} from "../../../../src/agents/tool-policy-shared.js";
import type { ToolsCatalogResult } from "../../api/types.ts";
import {
  SettingsSection,
  SettingsRow,
  SettingsToggle,
  SettingsLoadingSkeleton,
} from "../../components/solid/settings-ui.tsx";
import { GitHubIdentity } from "../../features/github-connections/github-identity-view.tsx";
import { GitLabManagedIdentity } from "../../features/gitlab-connections/gitlab-managed-identity-view.tsx";
import { registerSettingsEnglish } from "../../i18n/locales/en-settings.ts";
import { resolveAgentConfig } from "../../lib/agents/display.ts";
import {
  resolveToolProfileOptions,
  resolveToolSections,
  type AgentToolEntry,
} from "../../lib/agents/tool-catalog.ts";
import { i18nRevision, t } from "../../lib/reactive/i18n.ts";
import { resolveScrollBehavior } from "../../lib/scroll-behavior.ts";
import type { AgentsPageView } from "./agents-page-state.ts";
import { AgentConfigButtons, type AgentConfigActions } from "./config-actions.tsx";
import { AgentPanelAction, renderAgentPanelFacts } from "./panel-ui.tsx";
import {
  buildToolPresentation,
  renderToolMetaBadges,
  resolvePreviewTools,
  toToolAnchorId,
  ToolListed,
  ToolListedCount,
  ToolPreview,
  ToolRuntime,
  type EffectivePreview,
} from "./tools-preview.tsx";

registerSettingsEnglish();

export function AgentTools(
  params: AgentConfigActions &
    AgentsPageView["tools"] &
    Pick<AgentsPageView, "readData"> & {
      agentId: string;
      configForm: Record<string, unknown> | null;
    },
) {
  const toolGroups = new Map<
    HTMLDetailsElement,
    { readonly tools: AgentToolEntry[]; open: () => void }
  >();
  const toolTargets = new Map<
    HTMLElement,
    {
      anchorId: () => string;
      details: HTMLDetailsElement;
      summary: HTMLElement;
      group: HTMLDetailsElement;
    }
  >();
  const jumpToTool = (event: Event, anchorId: string) => {
    // Closed groups have no rows yet. Open the matching live group before resolving its row.
    const group = Array.from(toolGroups).find(
      ([element, entry]) =>
        element.isConnected && entry.tools.some((tool) => toToolAnchorId(tool.id) === anchorId),
    );
    if (!group) {
      return;
    }
    event.preventDefault();
    group[1].open();
    const nextUrl = new URL(window.location.href);
    nextUrl.hash = anchorId;
    window.history.replaceState(null, "", nextUrl);
    onSettled(() => {
      const target = Array.from(toolTargets.values()).find(
        (entry) => entry.anchorId() === anchorId && entry.group === group[0],
      );
      if (target?.details.isConnected) {
        target.details.open = true;
        target.details.scrollIntoView?.({ block: "center", behavior: resolveScrollBehavior() });
        target.summary.focus();
      }
    });
  };
  const config = createMemo(() => resolveAgentConfig(params.configForm, params.agentId));
  const agentTools = () => config().entry?.tools ?? {};
  const globalTools = () => config().globalTools ?? {};
  const profile = () => agentTools().profile ?? globalTools().profile ?? "full";
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
  const editable = () =>
    params.canUpdateConfig &&
    Boolean(params.configForm) &&
    !params.configLoading &&
    !params.configSaving &&
    !hasAgentAllow();
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
  const effectivePreviewTools = createMemo(() => resolvePreviewTools(params.readEffective()));

  function EffectiveBoundary(props: { children: (preview: EffectivePreview) => JSX.Element }) {
    const ready = (): EffectivePreview => {
      const result = params.readEffective();
      if (isPending(() => params.readEffective())) {
        return { result: null, status: "previewLoading", empty: "loadingPreview" };
      }
      return {
        result,
        facts: effectivePreviewTools(),
        status: result ? null : "previewNotLoaded",
        empty: result ? null : "previewNotLoaded",
      };
    };
    return (
      <Show
        when={params.runtimeSessionMatchesSelectedAgent}
        fallback={props.children({ status: "otherAgent", empty: "switchAgent", result: null })}
      >
        <Show when={params.effectiveRequest ?? params.agentId} keyed>
          <Errored
            fallback={(_error) =>
              props.children({
                status: "previewUnavailable",
                empty: "previewError",
                result: null,
              })
            }
          >
            <Loading
              on={params.effectiveRequest}
              fallback={props.children({
                status: "previewLoading",
                empty: "loadingPreview",
                result: null,
              })}
            >
              {props.children(ready())}
            </Loading>
          </Errored>
        </Show>
      </Show>
    );
  }

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

  function Configuration(props: {
    catalog: ToolsCatalogResult | null;
    pending?: boolean;
    failed?: boolean;
  }) {
    const profileOptions = createMemo(() => {
      i18nRevision();
      return resolveToolProfileOptions(props.catalog);
    });
    const toolIds = createMemo(() =>
      resolveToolSections(props.catalog).flatMap((section) => section.tools.map((tool) => tool.id)),
    );
    const enabledCount = createMemo(
      () => toolIds().filter((toolId) => resolveAllowed(toolId).allowed).length,
    );
    return (
      <>
        <For
          each={
            [
              [!params.configForm, "agentTools.loadConfig"],
              [hasAgentAllow(), "agentTools.explicitAllowlist"],
              [hasGlobalAllow(), "agentTools.globalAllowlist"],
              [props.failed, "agentTools.catalogFallback"],
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
              <Show when={props.failed}>
                <AgentPanelAction
                  label={t("common.retry")}
                  disabled={false}
                  onClick={() => params.onRetryCatalog()}
                />
              </Show>
              <For each={[true, false]}>
                {(enabled) => (
                  <AgentPanelAction
                    label={t(enabled ? "agentTools.enableAll" : "agentTools.disableAll")}
                    disabled={!editable() || (props.pending ?? false)}
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
            [
              "agentTools.listed",
              <EffectiveBoundary>
                {(preview) => <ToolListed preview={preview} />}
              </EffectiveBoundary>,
            ],
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
                <For each={profileOptions()} keyed={(option) => option.id}>
                  {(option) => (
                    <button
                      class={["btn btn--sm", { active: profile() === option().id }]}
                      disabled={!editable() || props.pending}
                      onClick={() => params.onProfileChange(params.agentId, option().id, true)}
                    >
                      {option().label}
                    </button>
                  )}
                </For>
                <AgentPanelAction
                  label={t("agentTools.inherit")}
                  disabled={!editable() || (props.pending ?? false)}
                  onClick={() => params.onProfileChange(params.agentId, null, false)}
                />
              </div>
            }
          />
        </SettingsSection>
      </>
    );
  }

  function Catalog(props: { catalog: ToolsCatalogResult | null }) {
    // Only ordering uses the retained answer; availability is read in the leaf boundaries below.
    const availableTools = createMemo(
      () =>
        new Map(
          (params.effectivePreview?.groups ?? [])
            .flatMap((group) => group.tools)
            .filter((tool) => !tool.deniedBySession)
            .map((tool) => [normalizeToolPolicyName(tool.id), tool] as const),
        ),
    );
    const toolSections = createMemo(() => {
      i18nRevision();
      return resolveToolSections(props.catalog);
    });
    return (
      <SettingsSection title={t("agentTools.catalogTitle")}>
        <div class="agents-panel-body agent-tools-grid">
          <For each={toolSections()} keyed={(section) => section.id}>
            {(section) => {
              let group!: HTMLDetailsElement;
              const [expanded, setExpanded] = createSignal(false);
              const toolDetails = new Set<HTMLDetailsElement>();
              const groupToggled = () => {
                setExpanded(group.open);
                if (!group.open) {
                  for (const details of toolDetails) {
                    details.open = false;
                  }
                }
              };
              onSettled(() => {
                toolGroups.set(group, {
                  get tools() {
                    return section().tools;
                  },
                  open() {
                    group.open = true;
                    setExpanded(true);
                  },
                });
                return () => toolGroups.delete(group);
              });
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
              const previewTools = createMemo(() => sortedTools().slice(0, 4));
              const remainingPreviewCount = () => sortedTools().length - previewTools().length;
              return (
                <details
                  ref={(element) => (group = element)}
                  class="agent-tools-group"
                  onToggle={groupToggled}
                >
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
                          ] as const
                        }
                      >
                        {(entry) => (
                          <span>
                            {t(`agentTools.${entry[0]}${entry[1] === 1 ? "One" : ""}`, {
                              count: String(entry[1]),
                            })}
                          </span>
                        )}
                      </For>
                      <EffectiveBoundary>
                        {(preview) => <ToolListedCount preview={preview} tools={section().tools} />}
                      </EffectiveBoundary>
                    </span>
                  </summary>
                  <Show when={expanded()}>
                    <div class="agent-tools-list">
                      <For each={sortedTools()} keyed={(tool) => tool.id}>
                        {(tool) => {
                          let details!: HTMLDetailsElement;
                          let summary!: HTMLElement;
                          onSettled(() => {
                            toolDetails.add(details);
                            return () => {
                              toolDetails.delete(details);
                              toolTargets.delete(summary);
                            };
                          });
                          const captureSummary = (element: HTMLElement) => {
                            summary = element;
                            toolTargets.set(summary, { anchorId, details, summary, group });
                          };
                          const anchorId = () => toToolAnchorId(tool().id);
                          const resolved = createMemo(() => resolveAllowed(tool().id));
                          const defaultProfiles = () => tool().defaultProfiles ?? [];
                          const sourceLabel = () =>
                            buildToolPresentation(section(), tool(), null).sourceLabel;
                          const policyLabels = createMemo(() => {
                            const policy = resolved();
                            const [state, policySummary]: [string, string] = policy.denied
                              ? ["agentTools.disabledByOverride", "agentTools.overrideOff"]
                              : policy.allowed
                                ? policy.baseAllowed
                                  ? ["agentTools.enabledByProfile", "agentTools.enabled"]
                                  : ["agentTools.enabledByOverride", "agentTools.overrideOn"]
                                : ["agentTools.notIncluded", "agentTools.profileOff"];
                            return { state: t(state), summary: t(policySummary) };
                          });
                          function PreviewPart(partProps: {
                            part: "summary" | "badges" | "details" | "policy";
                          }) {
                            return (
                              <EffectiveBoundary>
                                {(preview) => (
                                  <ToolPreview
                                    preview={preview}
                                    section={section()}
                                    tool={tool()}
                                    configDirty={params.configDirty}
                                    part={partProps.part}
                                  />
                                )}
                              </EffectiveBoundary>
                            );
                          }
                          return (
                            <details
                              ref={(element) => (details = element)}
                              class="agent-tool-card"
                              id={anchorId()}
                            >
                              <summary ref={captureSummary} class="agent-tool-summary">
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
                                      <PreviewPart part="summary" />
                                    </dd>
                                  </div>
                                </dl>
                                <div class="agent-tool-summary__badges">
                                  <PreviewPart part="badges" />
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
                                    <div>{sourceLabel()}</div>
                                  </div>
                                  {defaultProfiles().length > 0 ? (
                                    <div class="agent-tool-detail agent-tool-detail--inline">
                                      <div class="label">{t("agentTools.defaultPresets")}</div>
                                      {renderToolMetaBadges(defaultProfiles())}
                                    </div>
                                  ) : undefined}
                                  <div class="agent-tool-detail agent-tool-detail--inline">
                                    <div class="label">{t("agentTools.previewTitle")}</div>
                                    <div>
                                      <PreviewPart part="details" />
                                    </div>
                                  </div>
                                  <a class="agent-tool-jump" href={`#${anchorId()}`}>
                                    {t("agentTools.linkTool")}
                                  </a>
                                </div>
                                <PreviewPart part="policy" />
                              </div>
                            </details>
                          );
                        }}
                      </For>
                    </div>
                  </Show>
                </details>
              );
            }}
          </For>
        </div>
      </SettingsSection>
    );
  }

  return (
    <>
      <Show when={params.catalogRequest ?? params.agentId} keyed>
        <Errored fallback={(_error) => <Configuration catalog={null} failed />}>
          <Loading fallback={<Configuration catalog={null} pending />}>
            <Configuration catalog={params.readCatalog()} />
          </Loading>
        </Errored>
      </Show>
      <EffectiveBoundary>
        {(preview) => (
          <ToolRuntime
            preview={preview}
            sessionKey={params.runtimeSessionKey}
            onJump={jumpToTool}
          />
        )}
      </EffectiveBoundary>
      <GitHubIdentity
        identity={params.githubIdentity}
        onOpenConnections={params.onOpenGitHubConnections}
      />
      <SettingsSection title={t("agentTools.gitlabIdentityTitle")}>
        <GitLabManagedIdentity
          identity={params.gitlabIdentity}
          scope="agent"
          title={t("agentTools.gitlabAgentTitle")}
          description={t("agentTools.gitlabIdentityDescription")}
        />
      </SettingsSection>
      <Show when={params.catalogRequest ?? params.agentId} keyed>
        <Errored fallback={(_error) => <Catalog catalog={null} />}>
          <Loading
            fallback={
              <SettingsSection title={t("agentTools.catalogTitle")}>
                <SettingsLoadingSkeleton label={t("agentTools.loadingCatalog")} />
              </SettingsSection>
            }
          >
            <Catalog catalog={params.readCatalog()} />
          </Loading>
        </Errored>
      </Show>
    </>
  );
}
