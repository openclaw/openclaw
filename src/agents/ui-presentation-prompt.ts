import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";

/** Tool eligibility and results own surface support; do not infer it from channel names. */
export function buildUiPresentationPrompt(params: {
  screenToolName?: string;
  showWidgetToolName?: string;
  dashboardToolName?: string;
  portalToolName?: string;
  messageTool?: { name: string; parameters: unknown };
}): string {
  const { screenToolName, showWidgetToolName, dashboardToolName, portalToolName } = params;
  const messageProperties = asOptionalRecord(
    asOptionalRecord(params.messageTool?.parameters)?.properties,
  );
  // Source-only completion grants and other channels expose message without ClawHub.
  // Use the resolved schema so unavailable card actions never enter the prompt.
  const clawHubMessageToolName =
    messageProperties && Object.hasOwn(messageProperties, "clawhub")
      ? params.messageTool?.name
      : undefined;
  const lines = [
    screenToolName &&
      `\`${screenToolName}\`: \`${screenToolName}(action="browser_show")\`/\`browser_hide\` for agent Browser only (app previews use \`portal_show(portalId)\`, generic "side panel" needs intended content); \`sidebar_show|hide\`, \`terminal_show|hide\`, optional \`dock="right"|"bottom"\`. Never create/expand a dashboard to open a panel.`,
    clawHubMessageToolName &&
      `\`${clawHubMessageToolName}\`: tools/skills first. For explicit plugin/skill search/install or missing capability, use \`${clawHubMessageToolName}(action="send", clawhub={query:"capability"})\` (omit channel/target; skip for routine tasks/errors/permissions).`,
    showWidgetToolName &&
      `\`${showWidgetToolName}\`: use a widget when a visual helps (dashboards/charts/trackers/checklists/timers/choices) instead of text tables or chart images; use this turn's schema, \`pin=true\` saves to dashboard, follow \`result.presentation\`. Inline availability is per turn.`,
    dashboardToolName &&
      `\`${dashboardToolName}\`: layout/plugin widgets only (not HTML authoring or browser side panels); \`action="focus_tab"\` with \`tabId\` for saved widgets.${showWidgetToolName ? "" : " Custom authoring is unavailable this turn, not unsupported."}`,
    portalToolName &&
      `\`${portalToolName}\`: allocate port on the target environment (\`environmentId\` if attached, else omit), start app with \`PORT\` and \`PUBLIC_URL=publicUrl\`. Keep URLs unchanged and bearer URLs private (\`publicUrl\` != launch link; loopback-only is Gateway-local, non-loopback != remote-access proof).${screenToolName ? ` Open via \`${screenToolName}(action="portal_show", portalId="<id>")\`.` : " No `screen` tool this turn—direct viewer to Control UI → Portals."} Verify rendering from the requesting viewer (worker/Gateway fetch or panel dispatch != delivery proof); report blocked/unverified results.`,
    (showWidgetToolName || dashboardToolName) &&
      "Inspect widgets in their chat/dashboard frame (not hosting URLs as browser pages); verify interaction or say unverified.",
  ].filter(Boolean);
  return lines.length > 0 ? ["## UI Presentation", ...lines].join("\n") : "";
}
