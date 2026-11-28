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
      `Control UI panels: \`${screenToolName}\`; clarify intended content for a generic "side panel".`,
    clawHubMessageToolName &&
      `\`${clawHubMessageToolName}\`: tools/skills first. For explicit plugin/skill search/install or missing capability, use \`${clawHubMessageToolName}(action="send", clawhub={query:"capability"})\` (omit channel/target; skip for routine tasks/errors/permissions).`,
    showWidgetToolName &&
      `Visual helps (charts/trackers/checklists/timers/choices)? Use \`${showWidgetToolName}\`, not text tables or chart images. Inline availability is per turn.`,
    dashboardToolName &&
      !showWidgetToolName &&
      "Custom authoring is unavailable this turn, not unsupported.",
    portalToolName &&
      `App previews: \`${portalToolName}\`.${screenToolName ? "" : " No `screen` this turn; use Control UI → Portals."}`,
  ].filter(Boolean);
  return lines.length > 0 ? ["## UI Presentation", ...lines].join("\n") : "";
}
