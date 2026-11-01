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
      `\`${screenToolName}\`: For the agent Browser panel specifically, use \`${screenToolName}(action="browser_show")\`; browser_hide hides it. For an app preview, use portal_show with its portalId, not browser_show. A generic "side panel" request needs the intended content, not an automatic Browser panel. sidebar_show/sidebar_hide control the session list; terminal_show/terminal_hide control Terminal. Set dock="right" or "bottom" when requested. Do not create or expand a dashboard to open a panel.`,
    clawHubMessageToolName &&
      `\`${clawHubMessageToolName}\`: Tools/skills first. For explicit plugin/skill search/install or missing capability, use ClawHub: \`${clawHubMessageToolName}(action="send", clawhub={query:"capability"})\`. Skip routine tasks, tool errors, permissions. Omit channel/target. Trust result status.`,
    showWidgetToolName &&
      `\`${showWidgetToolName}\`: author widgets using this turn's schema. pin=true saves to the dashboard; status=pinned means the widget is on the session dashboard. Follow result.presentation when present. Inline availability is per turn, including after restart.`,
    dashboardToolName &&
      `\`${dashboardToolName}\`: layout/plugin widgets, not HTML authoring; never for opening a browser side panel. For a saved widget, use action="focus_tab" with its tabId.${showWidgetToolName ? "" : " Custom authoring is unavailable this turn, not unsupported by dashboards."}`,
    portalToolName &&
      `\`${portalToolName}\`: Open the app port on the correct environment (environmentId for an attachment; omit for a conversation-bound tool/current host), then start it there with PORT and PUBLIC_URL=publicUrl. Read exposure: loopback-only is local to the Gateway host; non-loopback is not proof of remote access. Keep URLs unchanged and bearer URLs private; publicUrl is not a launch link.${screenToolName ? ` Then use \`${screenToolName}(action="portal_show", portalId="<returned id>")\` to request the app side panel.` : " No screen tool is exposed this turn; do not claim to open a side panel. Direct the viewer to Control UI → Portals instead."} Verify app rendering from the requesting viewer; a worker/Gateway fetch or browser test is not delivery proof. Report blocked or unverified results; panel dispatch/transport alone is not app-rendering proof.`,
    (showWidgetToolName || dashboardToolName) &&
      "Inspect widgets in their chat/dashboard frame; do not open hosting URLs as browser pages. Verify the delivered interaction or say unverified.",
  ].filter(Boolean);
  return lines.length > 0 ? ["## UI Presentation", ...lines].join("\n") : "";
}
