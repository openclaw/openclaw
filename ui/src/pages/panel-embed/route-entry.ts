import { html, nothing } from "lit";
import { keyed } from "lit/directives/keyed.js";
import { t } from "../../i18n/index.ts";
import "../../styles/chat.ts";
import "../../styles/chat/side-panel.css";
import "../chat/chat-pane.ts";
import "./panel-embed.css";
import type { PanelEmbedTarget } from "./target.ts";

export function render(data: unknown, pending: boolean, presented = true) {
  // The colocated route loader is the only producer of this validated target.
  const target = data as PanelEmbedTarget | null | undefined;
  if (pending) {
    return nothing;
  }
  if (!target) {
    return html`<p role="alert">${t("chat.sessionRoute.notFoundExplanation")}</p>`;
  }
  const identity = JSON.stringify(target);
  return keyed(
    identity,
    html`<openclaw-chat-pane
      class="panel-embed-pane"
      .paneId=${identity}
      .presentationId=${identity}
      .sessionKey=${target.sessionKey}
      .agentId=${target.agentId}
      .panelEmbed=${target}
      .active=${presented}
      .presented=${presented}
      .visuallyPresented=${presented}
    ></openclaw-chat-pane>`,
  );
}
