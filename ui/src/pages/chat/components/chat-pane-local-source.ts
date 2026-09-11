import { html, type TemplateResult } from "lit";
import { t } from "../../../i18n/index.ts";
import type { SessionLocalSource } from "../../../lib/sessions/local-source.ts";

/** Header chip for a live local session; replaces the Runs-on placement chip. */
export function renderChatPaneLocalSource(source: SessionLocalSource): TemplateResult {
  const connection = source.connected
    ? source.state === "active"
      ? t("chat.localSession.stateActive")
      : t("chat.localSession.stateConnected")
    : t("chat.localSession.stateOffline");
  const label = t("chat.localSession.liveFrom", {
    owner: source.ownerLabel,
    source: source.sourceLabel,
  });
  return html`
    <div
      class="chat-pane__placement-control chat-pane__local-source"
      data-local-connected=${source.connected ? "true" : "false"}
      data-local-state=${source.state}
    >
      <span class="chat-pane__placement-chip chat-pane__local-source-chip" title=${label}>
        <span class="chat-pane__local-source-dot" aria-hidden="true"></span>
        ${label}
      </span>
      <span class="chat-pane__placement-state">${connection}</span>
    </div>
  `;
}
