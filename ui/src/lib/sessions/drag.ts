// Private MIME keeps stray text and file drags from becoming session actions.
export const SESSION_DRAG_MIME = "application/x-openclaw-session-key";
const SIDEBAR_SECTION_DRAG_MIME = "application/x-openclaw-session-group";
const SIDEBAR_ROUTE_DRAG_MIME = "application/x-openclaw-sidebar-route";

function createDragHandlers(mime: string, copyMove = false) {
  return {
    write: (dataTransfer: DataTransfer, value: string): void => {
      dataTransfer.setData(mime, value);
      if (copyMove) {
        // Sidebar sessions can move between groups or copy into a chat split pane.
        dataTransfer.setData("text/plain", value);
      }
      dataTransfer.effectAllowed = copyMove ? "copyMove" : "move";
    },
    read: (dataTransfer: DataTransfer | null): string | null => {
      return dataTransfer?.getData(mime).trim() || null;
    },
    active: (dataTransfer: DataTransfer | null): boolean => {
      return Array.from(dataTransfer?.types ?? []).includes(mime);
    },
  };
}

const sessionDrag = createDragHandlers(SESSION_DRAG_MIME, true);
const sectionDrag = createDragHandlers(SIDEBAR_SECTION_DRAG_MIME);
const routeDrag = createDragHandlers(SIDEBAR_ROUTE_DRAG_MIME);

export const writeSessionDragData = sessionDrag.write;
export const readSessionDragData = sessionDrag.read;
export const sessionDragActive = sessionDrag.active;
export const writeSidebarSectionDragData = sectionDrag.write;
export const readSidebarSectionDragData = sectionDrag.read;
export const sidebarSectionDragActive = sectionDrag.active;
export const writeSidebarRouteDragData = routeDrag.write;
export const readSidebarRouteDragData = routeDrag.read;
export const sidebarRouteDragActive = routeDrag.active;
