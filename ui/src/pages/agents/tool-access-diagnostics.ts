import { html, nothing } from "lit";
import type { ToolsEffectiveEntry, ToolsEffectiveResult } from "../../api/types.ts";
import { t } from "../../i18n/index.ts";
import { registerToolDiagnosticsEnglish } from "../../i18n/locales/en-tool-diagnostics.ts";
import { formatUiExternalText } from "../../lib/format-error.ts";
import { renderAgentPanelFacts } from "./panel-ui.ts";

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
        const suffix = index === 0 ? "" : "Provider";
        const globalLabel = t(`agentTools.profileGlobal${suffix}`);
        const agentLabel = t(`agentTools.profileAgent${suffix}`);
        const overrideLabel = t(`agentTools.profileAgent${suffix}Override`);
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

const TOOL_STATUS_LABELS = new Map([
  ["excluded", "agentTools.off"],
  ["allowed", "agentTools.allowedByConfig"],
  ["unavailable", "agentTools.notListed"],
  ["available", "agentTools.inPreview"],
]);

export function resolveToolAvailability(
  diagnostic: ToolAccessEntry | null,
  activeEntry: ToolsEffectiveEntry | null,
  unverifiedReason: string | null,
  previewStatus: string | null,
) {
  return {
    summary:
      previewStatus ||
      t(
        unverifiedReason
          ? "agentTools.unverified"
          : activeEntry?.deniedBySession
            ? "agentTools.off"
            : ((diagnostic && TOOL_STATUS_LABELS.get(diagnostic.status)) ??
              (activeEntry ? "agentTools.inPreview" : "agentTools.notListed")),
      ),
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
      ${renderAgentPanelFacts([
        [
          "agentTools.checked",
          t(
            toolAccess.checked === "live-session"
              ? "agentTools.checkedLive"
              : "agentTools.checkedLocal",
          ),
        ],
        diagnostic.reasons.length > 0
          ? [
              "agentTools.policySources",
              html`${diagnostic.reasons.map(
                (reason) => html`
                  <div>
                    ${formatUiExternalText(reason.label)}${reason.source ? html` · <code>${reason.source}</code>` : nothing}
                  </div>
                `,
              )}`,
            ]
          : null,
        toolAccess.profiles.length > 0
          ? ["agentTools.profileInheritance", renderProfileInheritance(toolAccess.profiles)]
          : null,
      ])}
    </div>
  `;
}

registerToolDiagnosticsEnglish();
