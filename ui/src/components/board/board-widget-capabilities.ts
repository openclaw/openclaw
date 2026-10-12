import { html, nothing, type TemplateResult } from "lit";
import { t } from "../../i18n/index.ts";
import type { BoardWidget } from "../../lib/board/types.ts";

export function renderBoardGrantedCapabilities(
  widget: BoardWidget,
  presentation: "tooltip" | "details" = "tooltip",
): TemplateResult | typeof nothing {
  if (widget.grantState !== "granted" || !widget.declared) {
    return nothing;
  }
  const capabilities = [
    ...(widget.declared.netOrigins ?? []).map((origin) =>
      t("board.widget.networkCapability", { capability: origin }),
    ),
    ...(widget.declared.tools ?? []).map((tool) =>
      t("board.widget.toolCapability", { capability: tool }),
    ),
  ];
  if (capabilities.length === 0) {
    return nothing;
  }
  if (presentation === "details") {
    return html`<div
      class="board-widget__menu-capabilities"
      role="note"
      aria-label=${t("board.widget.activeCapabilities")}
    >
      <strong>${t("board.widget.activeCapabilities")}</strong>
      <ul>
        ${capabilities.map((capability) => html`<li>${capability}</li>`)}
      </ul>
    </div>`;
  }
  return html`
    <openclaw-tooltip
      .content=${`${t("board.widget.activeCapabilities")}\n${capabilities.join("\n")}`}
    >
      <span class="board-widget__capabilities" data-test-id="board-capabilities-granted">
        ${t("board.widget.granted")}
      </span>
    </openclaw-tooltip>
  `;
}
