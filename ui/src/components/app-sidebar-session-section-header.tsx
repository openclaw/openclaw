import type { JSX } from "@solidjs/web";
import { createMemo, onSettled } from "solid-js";
import { writeSidebarSectionDragData } from "../lib/sessions/drag.ts";

// Only the header's trailing icon actions (new session, menus, filters) keep pure
// click gestures; the label, toggle, and status surfaces drag the section like a
// session row drags itself.
const DRAG_EXEMPT_CONTROL = ".sidebar-session-group-actions";

function startsOnHeaderAction(target: Element): boolean {
  return target.closest(DRAG_EXEMPT_CONTROL) !== null;
}

export function renderSidebarSessionSectionHeader(params: {
  sectionId: string;
  sectionHeaders: Map<string, HTMLElement>;
  content: JSX.Element;
  status?: {
    content: JSX.Element;
    label: string;
    expanded: boolean;
    title?: string;
    onToggle: () => void;
  };
  draggable?: boolean;
  disabledReason?: string;
  onStartDrag: (sectionId: string) => void;
  onFinishDrag: () => void;
  onContextMenu?: JSX.EventHandler<HTMLDivElement, MouseEvent>;
}) {
  const draggable = createMemo(() => params.draggable !== false && !params.disabledReason);
  let header!: HTMLElement;
  onSettled(() => {
    const sectionId = params.sectionId;
    const sectionHeaders = params.sectionHeaders;
    sectionHeaders.set(sectionId, header);
    return () => {
      if (sectionHeaders.get(sectionId) === header) {
        sectionHeaders.delete(sectionId);
      }
    };
  });
  return (
    <div
      ref={(element) => {
        header = element;
      }}
      class={[
        "sidebar-recent-sessions__head",
        draggable() && "sidebar-recent-sessions__head--draggable",
      ]}
      draggable={draggable() ? "true" : "false"}
      title={params.disabledReason}
      onMouseDown={(event) => {
        const currentHeader = event.currentTarget;
        currentHeader.toggleAttribute(
          "data-section-drag-blocked",
          startsOnHeaderAction(event.target),
        );
      }}
      onMouseUp={(event) => {
        event.currentTarget.removeAttribute("data-section-drag-blocked");
      }}
      onDragStart={(event) => {
        if (!draggable()) {
          event.preventDefault();
          return;
        }
        const currentHeader = event.currentTarget;
        const startedFromControl =
          startsOnHeaderAction(event.target) ||
          currentHeader.hasAttribute("data-section-drag-blocked");
        currentHeader.removeAttribute("data-section-drag-blocked");
        if (startedFromControl) {
          event.preventDefault();
          return;
        }
        if (event.dataTransfer) {
          writeSidebarSectionDragData(event.dataTransfer, params.sectionId);
          params.onStartDrag(params.sectionId);
        }
      }}
      onDragEnd={(event) => {
        event.currentTarget.removeAttribute("data-section-drag-blocked");
        params.onFinishDrag();
      }}
      onContextMenu={(event) => params.onContextMenu?.(event)}
    >
      {params.content}
      {params.status ? (
        <button
          type="button"
          class="sidebar-session-group-status"
          tabindex="-1"
          aria-label={params.status.label}
          aria-expanded={params.status.expanded ? "true" : "false"}
          title={params.status.title}
          onClick={() => params.status?.onToggle()}
        >
          {params.status.content}
        </button>
      ) : undefined}
    </div>
  );
}
