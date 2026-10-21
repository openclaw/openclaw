import type { JSX } from "@solidjs/web";
import { createMemo, onSettled, Show } from "solid-js";
import { writeSidebarSectionDragData } from "../lib/sessions/drag.ts";
import { renderSidebarReorderMenu as SidebarReorderMenu } from "./sidebar-reorder.tsx";
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
  reorder?: {
    label: string;
    onMove: (target: string, position: "before" | "after") => void | Promise<void>;
  };
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
          Boolean(event.target.closest("button, a")),
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
          Boolean(event.target.closest("button, a")) ||
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
      <span class="sidebar-session-group-drag-handle" aria-hidden="true" />
      {params.content}
      <Show when={draggable() && params.reorder}>
        {(reorder) => (
          <SidebarReorderMenu
            label={reorder().label}
            onMove={(target, position) => reorder().onMove(target, position)}
            sectionId={params.sectionId}
            sections={params.sectionHeaders}
          />
        )}
      </Show>
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
