import type { GhosttyTerminalController } from "@openclaw/libterminal/browser";

export function disposeTerminalController(
  controller: GhosttyTerminalController,
  host: HTMLDivElement,
): void {
  try {
    controller.dispose();
  } catch {
    // A partially initialized controller may fail during best-effort teardown.
  } finally {
    host.remove();
  }
}
