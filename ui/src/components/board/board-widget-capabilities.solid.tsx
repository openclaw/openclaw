import { createMemo, For, Show } from "solid-js";
import { registerBoardEnglish } from "../../i18n/locales/en-board.ts";
import type { BoardWidget } from "../../lib/board/types.ts";
import { registerEnglishCatalog, t } from "../../lib/reactive/i18n.ts";
import "../tooltip.ts";

registerEnglishCatalog(registerBoardEnglish);

export function BoardGrantedCapabilities(props: {
  widget: BoardWidget;
  presentation?: "tooltip" | "details";
}) {
  const capabilities = createMemo(() => [
    ...(props.widget.declared?.netOrigins ?? []).map((origin) =>
      t("board.widget.networkCapability", { capability: origin }),
    ),
    ...(props.widget.declared?.tools ?? []).map((tool) =>
      t("board.widget.toolCapability", { capability: tool }),
    ),
  ]);
  return (
    <Show when={props.widget.grantState === "granted" && capabilities().length > 0}>
      <Show
        when={props.presentation === "details"}
        fallback={
          <openclaw-tooltip
            prop:content={`${t("board.widget.activeCapabilities")}\n${capabilities().join("\n")}`}
          >
            <span class="board-widget__capabilities" data-test-id="board-capabilities-granted">
              {t("board.widget.granted")}
            </span>
          </openclaw-tooltip>
        }
      >
        <div
          class="board-widget__menu-capabilities"
          role="note"
          aria-label={t("board.widget.activeCapabilities")}
        >
          <strong>{t("board.widget.activeCapabilities")}</strong>
          <ul>
            <For keyed={false} each={capabilities()}>
              {(capability) => <li>{capability()}</li>}
            </For>
          </ul>
        </div>
      </Show>
    </Show>
  );
}
