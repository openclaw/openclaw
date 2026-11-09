import { Show } from "solid-js";
import type { BoardTab, BoardWidget } from "../../lib/board/types.ts";
import { t } from "../../lib/reactive/i18n.ts";
import type { MenuHandle } from "../solid/menu.tsx";
import { BoardGrantedCapabilities } from "./board-widget-capabilities.solid.tsx";
import { BoardWidgetMenu } from "./board-widget-menu.tsx";
import {
  LobbyComponentHeader,
  type createLobbyComponentDisclosure,
} from "./lobby-component-disclosure.tsx";

export function BoardWidgetHeader(props: {
  widget: BoardWidget;
  tabs: readonly BoardTab[];
  disclosure?: ReturnType<typeof createLobbyComponentDisclosure>;
  canMutate: boolean;
  menuAvailable: boolean;
  disabled: boolean;
  kindLabel: string;
  onMove: (event: PointerEvent) => void;
  onSelect: (value: string) => void;
  menuRef: (handle: MenuHandle) => void;
}) {
  const title = () => props.widget.title || props.widget.name;
  return (
    <div class="board-widget__chrome">
      <header class="board-widget__bar">
        <Show when={props.canMutate && !props.disclosure}>
          <span
            class="board-widget__drag-handle"
            aria-hidden="true"
            title={t("board.widget.moveHandle", { title: title() })}
            onPointerDown={(event) => props.onMove(event)}
          >
            <span aria-hidden="true">⠿</span>
          </span>
        </Show>
        <Show
          when={props.disclosure}
          fallback={
            <span class="board-widget__title" title={title()}>
              {title()}
            </span>
          }
        >
          {(disclosure) => (
            <LobbyComponentHeader
              title={title()}
              disclosure={disclosure()}
              description={props.widget.description}
            />
          )}
        </Show>
        <Show when={!props.disclosure}>
          <span class="board-widget__kind">{props.kindLabel}</span>
        </Show>
        <Show when={!props.disclosure}>
          <BoardGrantedCapabilities widget={props.widget} />
        </Show>
        <Show when={props.canMutate && props.menuAvailable && !props.disclosure}>
          <BoardWidgetMenu
            widget={props.widget}
            tabs={props.tabs}
            disabled={props.disabled}
            onSelect={(value) => props.onSelect(value)}
            ref={props.menuRef}
          />
        </Show>
      </header>
    </div>
  );
}
