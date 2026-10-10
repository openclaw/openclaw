import { html } from "lit";
import type { ToolCard, ToolCardOutcome } from "../../../lib/chat/chat-types.ts";
import type { ToolRenderOptions } from "./chat-tool-render-model.ts";
import "./chat-tool-content.solid.tsx";

export { toolWorkspacePath, type ToolRenderOptions } from "./chat-tool-render-model.ts";

// Temporary adapters for the remaining Lit transcript and sidebar callers.
export function renderRawOutputToggle(text: string) {
  return html`<openclaw-chat-tool-raw
    style="display: contents"
    .text=${text}
  ></openclaw-chat-tool-raw>`;
}

export function renderToolOutcome(outcome: ToolCardOutcome, exitCode?: number) {
  return html`<openclaw-chat-tool-outcome
    style="display: contents"
    .outcome=${outcome}
    .exitCode=${exitCode}
  ></openclaw-chat-tool-outcome>`;
}

export function renderExpandedToolCardContent(card: ToolCard, options: ToolRenderOptions) {
  return html`<openclaw-chat-tool-content
    style="display: contents"
    .card=${card}
    .options=${options}
  ></openclaw-chat-tool-content>`;
}
