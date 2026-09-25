const AGENT_DRAG_MIME = "application/x-openclaw-sidebar-agent";
export function writeSidebarAgentDragData(dataTransfer: DataTransfer | null, id: string) {
  dataTransfer?.setData(AGENT_DRAG_MIME, id);
  if (dataTransfer) {
    dataTransfer.effectAllowed = "move";
  }
}
export function sidebarAgentDragActive(dataTransfer: DataTransfer | null): boolean {
  return Array.from(dataTransfer?.types ?? []).includes(AGENT_DRAG_MIME);
}
export function readSidebarAgentDragData(dataTransfer: DataTransfer | null): string | null {
  return dataTransfer?.getData(AGENT_DRAG_MIME).trim() || null;
}
