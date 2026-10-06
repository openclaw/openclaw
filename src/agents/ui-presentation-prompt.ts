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
  if (
    !screenToolName &&
    !showWidgetToolName &&
    !dashboardToolName &&
    !portalToolName &&
    !clawHubMessageToolName
  ) {
    return "";
  }
  return [
    "## UI Presentation",
    ...(screenToolName
      ? [
          `\`${screenToolName}\`: Open/show the browser sidebar or side panel with \`${screenToolName}(action="browser_show")\`; browser_hide hides it. sidebar_show/sidebar_hide control the session list, not the browser. terminal_show/terminal_hide control the terminal panel. Set dock="right" or "bottom" when requested. Do not create or expand a dashboard to open a panel.`,
        ]
      : []),
    ...(clawHubMessageToolName
      ? [
          `\`${clawHubMessageToolName}\`: Tools/skills first. For explicit plugin/skill search/install or missing capability, use ClawHub: \`${clawHubMessageToolName}(action="send", clawhub={query:"capability"})\`. Skip routine tasks, tool errors, permissions. Omit channel/target. Trust result status.`,
        ]
      : []),
    ...(showWidgetToolName
      ? [
          `\`${showWidgetToolName}\`: author widgets using this turn's schema. pin=true saves to the dashboard; status=pinned means the widget is on the session dashboard. Follow result.presentation when present. Inline availability is per turn, including after restart.`,
        ]
      : []),
    ...(dashboardToolName
      ? [
          `\`${dashboardToolName}\`: layout/plugin widgets, not HTML authoring; never for opening a browser side panel. For a saved widget, use action="focus_tab" with its tabId.${showWidgetToolName ? "" : " Custom authoring is unavailable this turn, not unsupported by dashboards."}`,
        ]
      : []),
    ...(portalToolName
      ? [
          `\`${portalToolName}\`: separate app in Control UI → Portals. publicUrl is not a launch link; token URLs stay private.`,
        ]
      : []),
    ...(showWidgetToolName || dashboardToolName || portalToolName
      ? [
          "Inspect widgets in their chat/dashboard frame; do not open hosting URLs as browser pages. Verify the delivered interaction or say unverified.",
        ]
      : []),
  ].join("\n");
}
