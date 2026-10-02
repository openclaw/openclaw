import { html, nothing } from "lit";
import { normalizeToolPolicyName } from "../../../../src/agents/tool-policy-shared.js";
import type { ToolsEffectiveEntry, ToolsEffectiveResult } from "../../api/types.ts";
import { t } from "../../i18n/index.ts";
import { registerToolDiagnosticsEnglish } from "../../i18n/locales/en-tool-diagnostics.ts";
import { formatUiExternalText } from "../../lib/format-error.ts";

type ToolAccessDiagnostics = NonNullable<ToolsEffectiveResult["toolAccess"]>;
type ToolAccessEntry = ToolAccessDiagnostics["tools"][number];

function renderProfileInheritance(profiles: ToolAccessDiagnostics["profiles"]) {
  const baseProfiles = profiles.filter(
    (entry) => entry.source === "tools.profile" || entry.source.endsWith(".tools.profile"),
  );
  const providerProfiles = profiles.filter((entry) => !baseProfiles.includes(entry));
  const renderEntry = (entry: ToolAccessDiagnostics["profiles"][number], label: string) => html`
    <div class="agent-profile-tree__label">${label}</div>
    <div class="agent-profile-tree__details">
      <div class="agent-profile-tree__value">
        <code>${entry.profile}</code>
        ${entry.active ? html`<span class="chip">${t("agentTools.activeProfile")}</span>` : nothing}
      </div>
      <div class="agent-profile-tree__source">
        <code
          >${entry.source.split(".").map((segment, index) => html`${index > 0 ? html`.<wbr />` : nothing}${segment}`)}</code
        >
      </div>
    </div>
  `;
  return html`
    <ul class="agent-profile-tree" role="list">
      ${[baseProfiles, providerProfiles].map((entries, index) => {
        const global = entries.find((entry) => entry.source.startsWith("tools."));
        const agent = entries.find((entry) => !entry.source.startsWith("tools."));
        const root = global ?? agent;
        if (!root) {
          return nothing;
        }
        const globalLabel = t(
          index === 0 ? "agentTools.profileGlobal" : "agentTools.profileGlobalProvider",
        );
        const agentLabel = t(
          index === 0 ? "agentTools.profileAgent" : "agentTools.profileAgentProvider",
        );
        const overrideLabel = t(
          index === 0
            ? "agentTools.profileAgentOverride"
            : "agentTools.profileAgentProviderOverride",
        );
        return html`
          <li class=${global && agent ? "agent-profile-tree__branch" : ""}>
            ${renderEntry(root, global ? globalLabel : agentLabel)}
            ${
              global && agent
                ? html`<ul role="list">
                    <li>${renderEntry(agent, overrideLabel)}</li>
                  </ul>`
                : nothing
            }
          </li>
        `;
      })}
    </ul>
  `;
}

function formatToolRuntimeSummary(
  diagnostic: ToolAccessEntry | null,
  activeEntry: ToolsEffectiveEntry | null,
  unverifiedReason: string | null,
  previewStatus: string | null,
) {
  if (previewStatus) {
    return previewStatus;
  }
  if (unverifiedReason) {
    return t("agentTools.unverified");
  }
  if (activeEntry?.deniedBySession) {
    return t("agentTools.off");
  }
  switch (diagnostic?.status) {
    case "excluded":
      return t("agentTools.off");
    case "allowed":
      return t("agentTools.allowedByConfig");
    case "unavailable":
      return t("agentTools.notListed");
    case "available":
      return t("agentTools.inPreview");
    default:
      return activeEntry ? t("agentTools.inPreview") : t("agentTools.notListed");
  }
}

export function resolveToolAvailability(
  diagnostic: ToolAccessEntry | null,
  activeEntry: ToolsEffectiveEntry | null,
  unverifiedReason: string | null,
  previewStatus: string | null,
) {
  return {
    summary: formatToolRuntimeSummary(diagnostic, activeEntry, unverifiedReason, previewStatus),
    reason: previewStatus
      ? undefined
      : (unverifiedReason ??
        (activeEntry?.deniedBySession
          ? t("agentTools.sessionRestricted")
          : diagnostic?.reasons.map((reason) => formatUiExternalText(reason.label)).join(" · "))),
  };
}

export function renderToolPolicyDetails(
  diagnostic: ToolAccessEntry | null,
  toolAccess: ToolAccessDiagnostics | null,
) {
  if (!diagnostic || !toolAccess) {
    return nothing;
  }
  return html`
    <div class="agent-tool-policy">
      <dl class="settings-kv">
        <dt>${t("agentTools.checked")}</dt>
        <dd>
          ${t(toolAccess.checked === "live-session" ? "agentTools.checkedLive" : "agentTools.checkedLocal")}
        </dd>
        ${
          diagnostic.reasons.length > 0
            ? html`
                <dt>${t("agentTools.policySources")}</dt>
                <dd>
                  ${diagnostic.reasons.map(
                    (reason) => html`
                      <div>
                        ${formatUiExternalText(reason.label)}${reason.source ? html` · <code>${reason.source}</code>` : nothing}
                      </div>
                    `,
                  )}
                </dd>
              `
            : nothing
        }
        ${
          toolAccess.profiles.length > 0
            ? html`
                <dt>${t("agentTools.profileInheritance")}</dt>
                <dd>${renderProfileInheritance(toolAccess.profiles)}</dd>
              `
            : nothing
        }
      </dl>
    </div>
  `;
}

export function resolveToolAccessView(params: {
  configDirty: boolean;
  runtimeSessionMatchesSelectedAgent: boolean;
  toolsEffectiveLoading: boolean;
  toolsEffectiveError: string | null;
  toolsEffectiveResult: ToolsEffectiveResult | null;
}) {
  const previewStatus = !params.runtimeSessionMatchesSelectedAgent
    ? t("agentTools.otherAgent")
    : params.toolsEffectiveLoading
      ? t("agentTools.previewLoading")
      : params.toolsEffectiveError
        ? t("agentTools.previewUnavailable")
        : !params.toolsEffectiveResult
          ? t("agentTools.previewNotLoaded")
          : null;
  const previewResult = previewStatus ? null : params.toolsEffectiveResult;
  const unverifiedReason =
    previewStatus ?? (params.configDirty ? t("agentTools.unsavedAvailability") : null);
  const toolAccess = unverifiedReason ? null : (previewResult?.toolAccess ?? null);
  const diagnosticMap = new Map(
    toolAccess?.tools.map((tool) => [normalizeToolPolicyName(tool.id), tool] as const),
  );
  return { previewStatus, previewResult, unverifiedReason, toolAccess, diagnosticMap };
}

registerToolDiagnosticsEnglish();
