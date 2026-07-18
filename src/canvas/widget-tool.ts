/** Agent-facing inline chat widget tool. */
import { createHash } from "node:crypto";
import { Type } from "typebox";
import { type AnyAgentTool, jsonResult, readStringParam } from "../agents/tools/common.js";
import { assertWidgetHtmlSize, WidgetHtmlInputError } from "../plugin-sdk/widget-html.js";
import { createCanvasDocument } from "./documents.js";
import { buildWidgetDocument } from "./wrap.js";

const SHOW_WIDGET_REQUIRED_CLIENT_CAPS = ["inline-widgets"];
const WIDGET_CODE_MAX_CHARS = 262_144;
const WIDGET_MAX_PER_SCOPE = 32;

const ShowWidgetToolSchema = Type.Object({
  title: Type.String(),
  widget_code: Type.String(),
});

type ShowWidgetToolOptions = {
  sessionId?: string;
  agentId?: string;
  stateDir?: string;
};

function resolveRetentionScope(options: ShowWidgetToolOptions): string {
  const scope = options.sessionId
    ? `session:${options.sessionId}`
    : `agent:${options.agentId ?? "default"}`;
  return createHash("sha256").update(scope).digest("hex");
}

/** Creates a self-contained widget hosted by OpenClaw core. */
export function createShowWidgetTool(options: ShowWidgetToolOptions = {}): AnyAgentTool {
  return {
    label: "Show Widget",
    name: "show_widget",
    description:
      "Show an interactive, self-contained HTML or SVG widget to the user on their current surface. Inline all required code and data. Widgets inherit the host theme via CSS variables: --surface, --card, --elevated, --text, --text-strong, --muted, --border, --border-strong, --accent, --accent-fg, --ok, --warn, --danger, --info (plus --accent-subtle/--ok-subtle/--warn-subtle/--danger-subtle/--info-subtle tints), --radius, --font-body, --font-mono. Color everything with these variables — never hardcode hex colors or backgrounds, and do not define your own color palette or new :root color variables, so the widget matches every theme in light and dark mode. Bare button, input, select, textarea, table, and code elements are pre-styled; helper classes: .card, .badge (.ok/.warn/.danger/.info), .metric, .muted, .row, button.primary. Keep the page background transparent and reserve the accent color for at most one primary action. In web chat, a global sendPrompt(text) function submits text to the chat as if the user typed it — wire it to buttons or controls and append a ↗ to their labels. It only works after the user clicks inside the widget (plain conversational text only; slash commands are rejected), so never call it automatically.",
    parameters: ShowWidgetToolSchema,
    requiredClientCaps: SHOW_WIDGET_REQUIRED_CLIENT_CAPS,
    execute: async (_toolCallId, args) => {
      const params = args as Record<string, unknown>;
      const title = readStringParam(params, "title", { required: true });
      const rawWidgetCode = readStringParam(params, "widget_code", {
        required: true,
        trim: false,
      });
      if (!rawWidgetCode.trim()) {
        throw new WidgetHtmlInputError("widget_code required");
      }
      assertWidgetHtmlSize(rawWidgetCode, WIDGET_CODE_MAX_CHARS, {
        inputName: "widget_code",
        unit: "characters",
      });
      const widgetCode = rawWidgetCode.trim();
      const document = await createCanvasDocument(
        {
          kind: "html_bundle",
          title,
          entrypoint: { type: "html", value: buildWidgetDocument(title, widgetCode) },
          surface: "assistant_message",
          retentionScope: resolveRetentionScope(options),
          // Direct navigation must not run widget script as the Control UI origin.
          cspSandbox: "scripts",
        },
        {
          stateDir: options.stateDir,
          maxDocumentsPerScope: WIDGET_MAX_PER_SCOPE,
        },
      );
      return jsonResult({
        kind: "canvas",
        presentation: { target: "assistant_message", title, sandbox: "scripts" },
        view: { id: document.id, url: document.entryUrl },
        text: `Widget hosted at ${document.entryUrl}`,
      });
    },
  };
}
