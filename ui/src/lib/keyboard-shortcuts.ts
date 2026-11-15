export { resolveAsciiShortcutKey } from "../../../src/shared/keyboard-shortcuts.ts";

export function handleContextMenuEvent(
  event: MouseEvent | KeyboardEvent,
  trigger: HTMLElement | null,
  open: (trigger: HTMLElement | null, x: number, y: number) => void,
): void {
  if (event instanceof MouseEvent) {
    event.preventDefault();
    event.stopPropagation();
    open(trigger, event.clientX, event.clientY);
    return;
  }
  const shortcutKey = event.key === "ContextMenu" || (event.key === "F10" && event.shiftKey);
  if (event.altKey || event.ctrlKey || event.metaKey || !shortcutKey) {
    return;
  }
  if (!trigger && !(event.target instanceof HTMLElement)) {
    return;
  }
  // Prevent the shortcut default so macOS Chromium does not synthesize a second context menu.
  event.preventDefault();
  event.stopPropagation();
  const resolvedTrigger = trigger ?? (event.target as HTMLElement);
  const rect = resolvedTrigger.getBoundingClientRect();
  open(resolvedTrigger, rect.right, rect.bottom + 4);
}
