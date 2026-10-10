import { For, Show } from "solid-js";
import type { ToolsEffectiveEntry, ToolsEffectiveResult } from "../../api/types.ts";
import { registerToolDiagnosticsEnglish } from "../../i18n/locales/en-tool-diagnostics.ts";
import { formatUiExternalText } from "../../lib/format-error.ts";
import { t } from "../../lib/reactive/i18n.ts";
import { renderAgentPanelFacts } from "./panel-ui.tsx";

type ToolAccessDiagnostics = NonNullable<ToolsEffectiveResult["toolAccess"]>;
type ToolAccessEntry = ToolAccessDiagnostics["tools"][number];

function renderProfileInheritance(profiles: ToolAccessDiagnostics["profiles"]) {
  const baseProfiles = profiles.filter(
    (entry) => entry.source === "tools.profile" || entry.source.endsWith(".tools.profile"),
  );
  const providerProfiles = profiles.filter((entry) => !baseProfiles.includes(entry));
  const branches = [baseProfiles, providerProfiles].flatMap((entries, index) => {
    const global = entries.find((entry) => entry.source.startsWith("tools."));
    const agent = entries.find((entry) => !entry.source.startsWith("tools."));
    const root = global ?? agent;
    if (!root) {
      return [];
    }
    const suffix = index === 0 ? "" : "Provider";
    return [
      {
        root,
        label: t(`agentTools.profile${global ? "Global" : "Agent"}${suffix}`),
        child: global ? agent : undefined,
        childLabel: t(`agentTools.profileAgent${suffix}Override`),
      },
    ];
  });
  const renderEntry = (entry: ToolAccessDiagnostics["profiles"][number], label: string) => (
    <>
      <div class="agent-profile-tree__label">{label}</div>
      <div class="agent-profile-tree__details">
        <div class="agent-profile-tree__value">
          <code>{entry.profile}</code>
          {entry.active ? <span class="chip">{t("agentTools.activeProfile")}</span> : undefined}
        </div>
        <div class="agent-profile-tree__source">
          <code>
            <For each={entry.source.split(".")}>
              {(segment, index) => (
                <>
                  {index() > 0 ? (
                    <>
                      .<wbr />
                    </>
                  ) : undefined}
                  {segment}
                </>
              )}
            </For>
          </code>
        </div>
      </div>
    </>
  );
  return (
    <ul class="agent-profile-tree" role="list">
      <For each={branches}>
        {(branch) => (
          <li class={branch.child ? "agent-profile-tree__branch" : ""}>
            {renderEntry(branch.root, branch.label)}
            <Show when={branch.child} keyed>
              {(child) => (
                <ul role="list">
                  <li>{renderEntry(child, branch.childLabel)}</li>
                </ul>
              )}
            </Show>
          </li>
        )}
      </For>
    </ul>
  );
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
    return undefined;
  }
  return (
    <div class="agent-tool-policy">
      {renderAgentPanelFacts([
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

              <For each={diagnostic.reasons}>
                {(reason) => (
                  <div>
                    {formatUiExternalText(reason.label)}
                    {reason.source ? (
                      <>
                        {" "}
                        · <code>{reason.source}</code>
                      </>
                    ) : undefined}
                  </div>
                )}
              </For>,
            ]
          : null,
        toolAccess.profiles.length > 0
          ? ["agentTools.profileInheritance", renderProfileInheritance(toolAccess.profiles)]
          : null,
      ])}
    </div>
  );
}

registerToolDiagnosticsEnglish();
