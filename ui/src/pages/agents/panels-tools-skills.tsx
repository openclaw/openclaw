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
import { Icon } from "../../components/solid/icon.tsx";
import { InlineAlert } from "../../components/solid/inline-alert.tsx";
import {
  SettingsSection,
  SettingsRow,
  SettingsSegmented,
  SettingsToggle,
  SettingsLoadingSkeleton,
} from "../../components/solid/settings-ui.tsx";
import { GitHubIdentity } from "../../features/github-connections/github-identity-view.tsx";
import { registerSettingsEnglish } from "../../i18n/locales/en-settings.ts";
import { resolveAgentConfig } from "../../lib/agents/display.ts";
import {
  resolveToolProfileOptions,
  resolveToolSections,
  type AgentToolEntry,
} from "../../lib/agents/tool-catalog.ts";
import { resolveAgentConfigEntryTarget } from "../../lib/config/config-state-model.ts";
import { i18nRevision, t } from "../../lib/reactive/i18n.ts";
import { resolveScrollBehavior } from "../../lib/scroll-behavior.ts";
import type { AgentsPageView } from "./agents-page-state.ts";
import { AgentPanelAction, renderAgentPanelFacts, type AgentConfigState } from "./panel-ui.tsx";
import {
  buildToolPresentation,
  renderToolMetaBadges,
  resolvePreviewTools,
  toToolAnchorId,
  ToolListed,
  ToolPreview,
  ToolRuntime,
  type EffectivePreview,
} from "./tools-preview.tsx";

registerSettingsEnglish();

export function AgentTools(
  params: AgentConfigState &
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
      : // Runtime resolves custom profile refs against tools.profiles; mirror that
        // here so panel enrollment and saved geometry match the effective policy.
        resolveToolProfilePolicy(profile(), globalTools().profiles),
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
              [!params.configForm, "agentTools.loadConfig", undefined],
              [
                hasAgentAllow(),
                "agentTools.explicitAllowlist",
                resolveAgentConfigEntryTarget(params.configForm, params.agentId)
                  ?.path.concat("tools", "allow")
                  .join("."),
              ],
              [hasGlobalAllow(), "agentTools.globalAllowlist", "tools.allow"],
              [props.failed, "agentTools.catalogFallback", undefined],
            ] as const
          }
        >
          {(entry) =>
            entry[0] ? (
              <InlineAlert tone="info">
                {t(entry[1])}
                {entry[2] ? (
                  <>
                    {" "}
                    <code>{entry[2]}</code>
                  </>
                ) : undefined}
              </InlineAlert>
            ) : undefined
          }
        </For>
        <SettingsSection
          title={t("agentTools.title")}
          description={
            <>
              {t("agentTools.subtitle")}{" "}
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
          ])}
          <SettingsRow
            title={t("agentTools.quickPresets")}
            stackedOnNarrow
            control={
              <div class="agent-tools-buttons">
                <SettingsSegmented
                  mode="buttons"
                  ariaLabel={t("agentTools.quickPresets")}
                  value={profile()}
                  options={profileOptions().map((option) => ({
                    value: option.id,
                    label: option.label,
                  }))}
                  disabled={!editable() || props.pending}
                  onChange={(id) => params.onProfileChange(params.agentId, id, true)}
                  onReselect={(id) => params.onProfileChange(params.agentId, id, true)}
                />
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
              // Name order, so a row never moves when its toggle or the preview changes.
              const sortedTools = createMemo(() =>
                section().tools.toSorted((left, right) => left.label.localeCompare(right.label)),
              );
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
                    <Icon name="chevronRight" class="agent-tools-chevron" />
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
                      <span
                        title={t("agentTools.enabledSummary", {
                          enabled: String(enabledSectionCount()),
                          total: String(section().tools.length),
                        })}
                      >
                        {enabledSectionCount()}/{section().tools.length}
                      </span>
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
                            buildToolPresentation(section(), tool()).sourceLabel;
                          const policyState = createMemo(() => {
                            const policy = resolved();
                            return t(
                              policy.denied
                                ? "agentTools.disabledByOverride"
                                : policy.allowed
                                  ? policy.baseAllowed
                                    ? "agentTools.enabledByProfile"
                                    : "agentTools.enabledByOverride"
                                  : "agentTools.notIncluded",
                            );
                          });
                          function PreviewPart(partProps: { part: "details" | "policy" }) {
                            return (
                              <EffectiveBoundary>
                                {(preview) => (
                                  <ToolPreview
                                    preview={preview}
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
                                <Icon name="chevronRight" class="agent-tools-chevron" />
                                <div class="agent-tool-summary__main">
                                  <span class="agent-tool-title mono" translate="no">
                                    {tool().label}
                                  </span>
                                  <div class="agent-tool-sub" title={tool().description}>
                                    {tool().description}
                                  </div>
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
                                {renderAgentPanelFacts([
                                  ["agentTools.access", policyState()],
                                  [
                                    "agentTools.source",
                                    tool().optional
                                      ? `${sourceLabel()} · ${t("agentTools.optional")}`
                                      : sourceLabel(),
                                  ],
                                  defaultProfiles().length > 0
                                    ? [
                                        "agentTools.defaultPresets",
                                        renderToolMetaBadges(defaultProfiles()),
                                      ]
                                    : null,
                                  ["agentTools.previewTitle", <PreviewPart part="details" />],
                                ])}
                                <PreviewPart part="policy" />
                                <a class="agent-tool-jump" href={`#${anchorId()}`}>
                                  {t("agentTools.linkTool")}
                                </a>
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
