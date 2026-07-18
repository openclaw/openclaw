import { html, nothing, type TemplateResult } from "lit";
import { ref } from "lit/directives/ref.js";
import { icons } from "../../components/icons.ts";
import { t } from "../../i18n/index.ts";
import { isMockBoardEnabled, type BoardViewCallbacks } from "../../lib/board/provider.ts";
import type { BoardFace } from "../../lib/board/settings.ts";
import type { BoardSnapshot, BoardTab } from "../../lib/board/types.ts";

type VisibleBoardDock = Exclude<BoardTab["chatDock"], "hidden">;

export type BoardChatDockSize = {
  height: number;
  width: number;
};

type BoardSessionSurfaceProps = {
  snapshot: BoardSnapshot;
  activeTabId: string;
  dock: BoardTab["chatDock"];
  reopenDock: VisibleBoardDock;
  dockSize: BoardChatDockSize;
  chat: TemplateResult;
  callbacks: BoardViewCallbacks;
  onDockChange: (dock: BoardTab["chatDock"]) => void;
  onResize: (dock: VisibleBoardDock, event: CustomEvent<{ splitRatio: number }>) => void;
};

let placeholderLoad: Promise<unknown> | null = null;

export async function ensureBoardViewElement(): Promise<boolean> {
  if (customElements.get("openclaw-board-view") || !isMockBoardEnabled()) {
    return false;
  }
  placeholderLoad ??= import("../../components/board-view-placeholder.ts");
  await placeholderLoad;
  return true;
}

export function renderBoardFaceToggle(
  hasBoard: boolean,
  face: BoardFace,
  onChange: (face: BoardFace) => void,
) {
  if (!hasBoard) {
    return nothing;
  }
  const selectFromKeyboard = (event: KeyboardEvent, nextFace: BoardFace) => {
    const target = event.currentTarget as HTMLElement;
    event.preventDefault();
    onChange(nextFace);
    queueMicrotask(() => {
      const group = target.closest(".chat-pane__face-switch");
      group?.querySelector<HTMLElement>(`[data-board-face="${nextFace}"]`)?.focus();
    });
  };
  return html`
    <div class="chat-pane__face-switch" role="tablist" aria-label=${t("chat.board.faceLabel")}>
      ${(["chat", "dashboard"] as const).map((candidate) => {
        const selected = candidate === face;
        return html`<button
          type="button"
          role="tab"
          data-board-face=${candidate}
          aria-selected=${String(selected)}
          tabindex=${selected ? "0" : "-1"}
          @click=${() => onChange(candidate)}
          @keydown=${(event: KeyboardEvent) => {
            if (event.key === "ArrowLeft" || event.key === "Home") {
              selectFromKeyboard(event, "chat");
            } else if (event.key === "ArrowRight" || event.key === "End") {
              selectFromKeyboard(event, "dashboard");
            }
          }}
        >
          ${candidate === "chat" ? t("chat.board.chatFace") : t("chat.board.dashboardFace")}
        </button>`;
      })}
    </div>
  `;
}

function dockIcon(dock: BoardTab["chatDock"]) {
  if (dock === "left") {
    return icons.panelLeftOpen;
  }
  if (dock === "bottom") {
    return icons.panelBottomOpen;
  }
  if (dock === "hidden") {
    return icons.eyeOff;
  }
  return icons.panelRightOpen;
}

function dockLabel(dock: BoardTab["chatDock"]): string {
  if (dock === "left") {
    return t("chat.board.dockLeft");
  }
  if (dock === "bottom") {
    return t("chat.board.dockBottom");
  }
  if (dock === "hidden") {
    return t("chat.board.dockHidden");
  }
  return t("chat.board.dockRight");
}

export function renderBoardDockMenu(
  hasBoard: boolean,
  face: BoardFace,
  dock: BoardTab["chatDock"],
  onChange: (dock: BoardTab["chatDock"]) => void,
) {
  if (!hasBoard || face !== "dashboard") {
    return nothing;
  }
  return html`
    <wa-dropdown
      class="chat-pane__board-dock-menu"
      placement="bottom-end"
      @wa-select=${(event: CustomEvent<{ item: { value?: string } }>) => {
        const value = event.detail.item.value;
        if (value === "left" || value === "right" || value === "bottom" || value === "hidden") {
          onChange(value);
        }
      }}
    >
      <button
        slot="trigger"
        type="button"
        class="btn btn--ghost btn--icon chat-icon-btn"
        data-board-dock-menu
        title=${dockLabel(dock)}
        aria-label=${t("chat.board.dockMenu", { dock: dockLabel(dock) })}
      >
        ${dockIcon(dock)}
      </button>
      ${(["left", "right", "bottom", "hidden"] as const).map(
        (candidate) => html`
          <wa-dropdown-item value=${candidate} type="checkbox" ?checked=${candidate === dock}>
            ${dockLabel(candidate)}
          </wa-dropdown-item>
        `,
      )}
    </wa-dropdown>
  `;
}

export function boardDividerRatio(
  previousSize: number,
  nextSize: number,
  dock?: VisibleBoardDock,
): number | null {
  const total = previousSize + nextSize;
  if (total <= 0) {
    return null;
  }
  return (dock === "left" ? nextSize : previousSize) / total;
}

function renderDivider(dock: VisibleBoardDock, onResize: BoardSessionSurfaceProps["onResize"]) {
  return html`<resizable-divider
    ${ref((element) => {
      if (!(element instanceof HTMLElement)) {
        return;
      }
      queueMicrotask(() => {
        const previous = element.previousElementSibling?.getBoundingClientRect();
        const next = element.nextElementSibling?.getBoundingClientRect();
        const ratio = boardDividerRatio(
          dock === "bottom" ? (previous?.height ?? 0) : (previous?.width ?? 0),
          dock === "bottom" ? (next?.height ?? 0) : (next?.width ?? 0),
          dock,
        );
        if (ratio !== null) {
          (element as HTMLElement & { splitRatio: number }).splitRatio = ratio;
        }
      });
    })}
    class="board-session-surface__divider"
    .orientation=${dock === "bottom" ? "horizontal" : "vertical"}
    .splitRatio=${0.5}
    .minRatio=${0.2}
    .maxRatio=${0.8}
    .label=${t("chat.board.resizeDock")}
    @resize=${(event: CustomEvent<{ splitRatio: number }>) => onResize(dock, event)}
  ></resizable-divider>`;
}

function renderBoardView(props: BoardSessionSurfaceProps) {
  const widgetFrameUrl = (name: string, revision: number) =>
    `about:blank#board-widget=${encodeURIComponent(name)}&revision=${revision}`;
  return html`
    <div class="board-session-surface__board">
      <openclaw-board-view
        .snapshot=${props.snapshot}
        .activeTabId=${props.activeTabId}
        .widgetFrameUrl=${widgetFrameUrl}
        .callbacks=${props.callbacks}
      ></openclaw-board-view>
    </div>
  `;
}

function renderChatDock(props: BoardSessionSurfaceProps, dock: VisibleBoardDock) {
  const style =
    dock === "bottom" ? `height: ${props.dockSize.height}px` : `width: ${props.dockSize.width}px`;
  return html`<div class="board-session-surface__chat" style=${style}>${props.chat}</div>`;
}

export function renderBoardSessionSurface(props: BoardSessionSurfaceProps) {
  const layoutDock = props.dock === "hidden" ? props.reopenDock : props.dock;
  const board = renderBoardView(props);
  const chat = renderChatDock(props, layoutDock);
  const divider = renderDivider(layoutDock, props.onResize);
  return html`
    <div class="board-session-surface board-session-surface--dock-${props.dock}">
      ${board} ${divider} ${chat}
      <button
        type="button"
        class="board-session-surface__reopen board-session-surface__reopen--${props.reopenDock}"
        aria-label=${t("chat.board.reopenChat")}
        title=${t("chat.board.reopenChat")}
        ?hidden=${props.dock !== "hidden"}
        @click=${() => props.onDockChange(props.reopenDock)}
      >
        ${icons.messageSquare}<span>${t("chat.board.chatFace")}</span>
      </button>
    </div>
  `;
}
