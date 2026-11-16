import { isApplePlatform } from "../../../src/shared/keyboard-shortcuts.ts";
import { isIosBrowserPlatform } from "../lib/browser-platform.ts";

/** WKWebView can omit contextmenu for a Mac Control-click on an anchor. */
export function createSidebarSessionContextMenu(open: (event: MouseEvent | KeyboardEvent) => void) {
  let openedBy: string | undefined;
  const handle = (event: MouseEvent | KeyboardEvent) => {
    if (event instanceof MouseEvent) {
      event.preventDefault();
      event.stopPropagation();
      // Browsers can deliver both events, in either order, for one gesture.
      if (openedBy && openedBy !== event.type) {
        openedBy = undefined;
        return;
      }
      openedBy = event.type;
    } else {
      openedBy = undefined;
    }
    open(event);
  };
  return {
    onPointerDown() {
      openedBy = undefined;
    },
    onClick(event: MouseEvent): boolean {
      if (
        event.defaultPrevented ||
        event.button !== 0 ||
        !event.ctrlKey ||
        event.metaKey ||
        !isApplePlatform() ||
        isIosBrowserPlatform()
      ) {
        openedBy = undefined;
        return false;
      }
      handle(event);
      return true;
    },
    onContextMenu: handle,
  };
}
