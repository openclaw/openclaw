import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";

/** Tool eligibility and results own surface support; do not infer it from channel names. */
export function buildUiPresentationPrompt(params: {
  showWidgetToolName?: string;
  dashboardToolName?: string;
  portalToolName?: string;
  messageTool?: { name: string; parameters: unknown };
}): string {
  const { showWidgetToolName, dashboardToolName, portalToolName } = params;
  const messageProperties = asOptionalRecord(
    asOptionalRecord(params.messageTool?.parameters)?.properties,
  );
  // Source-only completion grants and other channels expose message without ClawHub.
  // Use the resolved schema so unavailable card actions never enter the prompt.
  const clawHubMessageToolName =
    messageProperties && Object.hasOwn(messageProperties, "clawhub")
      ? params.messageTool?.name
      : undefined;
  if (!showWidgetToolName && !dashboardToolName && !portalToolName && !clawHubMessageToolName) {
    return "";
  }
  return [
    "## UI Presentation",
    ...(clawHubMessageToolName
      ? [
          `\`${clawHubMessageToolName}\`: When the user asks to install an integration or whether you can perform an action, check ClawHub first with \`${clawHubMessageToolName}(action="send", clawhub={query:"capability"})\`, omitting channel and target. This presents official plugin or skill cards, including when it is already installed. Report availability and installation state from the result. An installed desktop app does not establish that its OpenClaw plugin is installed. Treat an unqualified service install request as an OpenClaw capability request unless the user explicitly asks for a desktop app.`,
        ]
      : []),
    ...(showWidgetToolName
      ? [
          `\`${showWidgetToolName}\`: self-contained sandboxed HTML/JS; pin=true adds a Control UI dashboard widget. Follow result.presentation; inline support varies by surface.`,
        ]
      : []),
    ...(dashboardToolName
      ? [
          `\`${dashboardToolName}\`: layout/plugin widgets, not HTML authoring.${showWidgetToolName ? "" : " Custom authoring is unavailable this turn, not unsupported by dashboards."}`,
        ]
      : []),
    ...(portalToolName
      ? [
          `\`${portalToolName}\`: separate app in Control UI → Portals. publicUrl is not a launch link; token URLs stay private.`,
        ]
      : []),
    "Browser tabs, links, and launch cards are not embeds. Verify the delivered interaction or say unverified.",
  ].join("\n");
}
