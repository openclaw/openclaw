export const SESSION_DRAG_MIME = "application/x-openclaw-session-key";

export function writeSessionDragData(dataTransfer: DataTransfer, sessionKey: string): void {
  dataTransfer.setData(SESSION_DRAG_MIME, sessionKey);
  dataTransfer.setData("text/plain", sessionKey);
  dataTransfer.effectAllowed = "copy";
}

export function readSessionDragData(dataTransfer: DataTransfer | null): string | null {
  const sessionKey = dataTransfer?.getData(SESSION_DRAG_MIME).trim();
  return sessionKey || null;
}

export function sessionDragActive(dataTransfer: DataTransfer | null): boolean {
  return Array.from(dataTransfer?.types ?? []).includes(SESSION_DRAG_MIME);
}
