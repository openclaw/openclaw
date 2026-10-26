import { createMemo, For, Show } from "solid-js";
import { normalizeToolPolicyName } from "../../../../src/agents/tool-policy-shared.js";
import type { ToolsEffectiveEntry, ToolsEffectiveResult } from "../../api/types.ts";
import {
  SettingsSection,
  SettingsEmpty,
  SettingsLoadingSkeleton,
} from "../../components/solid/settings-ui.tsx";
import type { AgentToolEntry, AgentToolSection } from "../../lib/agents/tool-catalog.ts";
import { formatUiExternalText } from "../../lib/format-error.ts";
import { t } from "../../lib/reactive/i18n.ts";
import { resolveToolAvailability, renderToolPolicyDetails } from "./tool-access-diagnostics.tsx";

export function renderToolMetaBadges(labels: string[]) {
  if (labels.length === 0) {
    return undefined;
  }
  return (
    <div class="agent-tool-badges">
      <For each={labels}>{(label) => <span class="settings-row__value">{label}</span>}</For>
    </div>
  );
}

export function buildToolPresentation(
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

export function toToolAnchorId(toolId: string) {
  const safe = normalizeToolPolicyName(toolId).replace(/[^a-z0-9_-]+/g, "-");
  return `agent-tool-${safe}`;
}

const MAX_RUNTIME_TOOL_CHIPS = 12;

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

export function resolvePreviewTools(result: ToolsEffectiveResult | null) {
  const tools = (result?.groups ?? []).flatMap((group) => group.tools);
  return {
    active: new Map(tools.map((tool) => [normalizeToolPolicyName(tool.id), tool] as const)),
    available: new Map(
      tools
        .filter((tool) => !tool.deniedBySession)
        .map((tool) => [normalizeToolPolicyName(tool.id), tool] as const),
    ),
    diagnostics: new Map(
      result?.toolAccess?.tools.map((tool) => [normalizeToolPolicyName(tool.id), tool] as const),
    ),
  };
}

export type EffectivePreview = {
  status: "otherAgent" | "previewLoading" | "previewUnavailable" | "previewNotLoaded" | null;
  empty: "switchAgent" | "loadingPreview" | "previewError" | "previewNotLoaded" | null;
  result: ToolsEffectiveResult | null;
  facts?: ReturnType<typeof resolvePreviewTools>;
};

function previewStatus(preview: EffectivePreview) {
  return preview.status ? t(`agentTools.${preview.status}`) : null;
}

export function ToolRuntime(props: {
  preview: EffectivePreview;
  sessionKey: string;
  onJump: (event: Event, anchorId: string) => void;
}) {
  const uniqueEffectiveTools = () => [...(props.preview.facts?.available.values() ?? [])];
  const visibleEffectiveTools = () => uniqueEffectiveTools().slice(0, MAX_RUNTIME_TOOL_CHIPS);
  const hiddenEffectiveToolCount = () =>
    uniqueEffectiveTools().length - visibleEffectiveTools().length;
  const availability = () => {
    const current = props.preview.status ? props.preview : null;
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
                  onClick={(event: Event) => props.onJump(event, anchorId())}
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
  };
  return (
    <SettingsSection
      title={t("agentTools.previewTitle")}
      description={
        <>
          {t("agentTools.previewSubtitle")}
          <span class="mono">{props.sessionKey || t("agentTools.noSession")}</span>
        </>
      }
    >
      <Show when={props.preview.result?.notices?.length}>
        <div class="agent-tools-notices">
          <For each={props.preview.result?.notices}>
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
      {availability()}
    </SettingsSection>
  );
}

export function ToolListed(props: { preview: EffectivePreview }) {
  return <code>{previewStatus(props.preview) ?? props.preview.facts?.available.size ?? 0}</code>;
}

export function ToolPreview(props: {
  preview: EffectivePreview;
  section: AgentToolSection;
  tool: AgentToolEntry;
  part: "summary" | "badges" | "details" | "policy";
  configDirty: boolean;
}) {
  const status = () => previewStatus(props.preview);
  const unverifiedReason = () =>
    status() ?? (props.configDirty ? t("agentTools.unsavedAvailability") : null);
  const toolAccess = () => (unverifiedReason() ? null : (props.preview.result?.toolAccess ?? null));
  const activeEntry = () =>
    props.preview.facts?.active.get(normalizeToolPolicyName(props.tool.id)) ?? null;
  const diagnostic = () =>
    unverifiedReason()
      ? null
      : (props.preview.facts?.diagnostics.get(normalizeToolPolicyName(props.tool.id)) ?? null);
  const availability = createMemo(
    () => resolveToolAvailability(diagnostic(), activeEntry(), unverifiedReason(), status()),
    { lazy: true },
  );
  const label = () => {
    const reason = unverifiedReason();
    if (reason) {
      return reason;
    }
    const entry = activeEntry();
    return entry?.deniedBySession
      ? t("agentTools.sessionRestricted")
      : entry
        ? t("agentTools.previewVia", { source: renderEffectiveToolBadge(entry) })
        : availability().reason || availability().summary;
  };
  return (
    <>
      {props.part === "summary" ? (
        <>
          {availability().summary}
          {availability().reason ? <div class="muted">{availability().reason}</div> : undefined}
        </>
      ) : props.part === "badges" ? (
        renderToolMetaBadges(buildToolPresentation(props.section, props.tool, activeEntry()).badges)
      ) : props.part === "details" ? (
        label()
      ) : (
        renderToolPolicyDetails(diagnostic(), toolAccess())
      )}
    </>
  );
}

export function ToolListedCount(props: { preview: EffectivePreview; tools: AgentToolEntry[] }) {
  const count = () =>
    props.tools.filter((tool) =>
      props.preview.facts?.available.has(normalizeToolPolicyName(tool.id)),
    ).length;
  return (
    <Show when={count()}>
      {(value) => (
        <span>
          {t(`agentTools.listedTools${value() === 1 ? "One" : ""}`, { count: String(value()) })}
        </span>
      )}
    </Show>
  );
}
