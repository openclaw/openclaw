import { createSignal, onCleanup } from "solid-js";
import type { AppSidebarSessionNavigationElement } from "./app-sidebar-session-navigation.ts";
import type { SidebarSessionsScrollState } from "./app-sidebar-session-types.ts";
import { observeScrollState } from "./scroll-state-observer.ts";

/** Preserve the shared sidebar's scroll position for each destination. */
export function createSidebarScroll(
  host: Pick<
    AppSidebarSessionNavigationElement,
    "isConnected" | "navigationView" | "contextualSidebar"
  >,
) {
  const positions = new Map<string, number>();
  const [state, setState] = createSignal<SidebarSessionsScrollState>("none");
  let presentedKey = "sessions";
  let scroller: HTMLElement | undefined;
  let observation: ReturnType<typeof observeScrollState> | undefined;
  const key = () =>
    host.navigationView === "sessions"
      ? (host.contextualSidebar?.key ?? "sessions")
      : host.navigationView;
  return {
    state,
    createRef() {
      // The frame can disappear while its containing sidebar retains destination offsets.
      onCleanup(() => {
        observation?.disconnect();
        observation = undefined;
        scroller = undefined;
      });
      return (element: HTMLElement) => {
        scroller = element;
        observation = observeScrollState(element, (next) =>
          setState(
            !next.scrollable ? "none" : next.atStart ? "top" : next.atEnd ? "bottom" : "middle",
          ),
        );
      };
    },
    capture() {
      if (host.isConnected && key() !== presentedKey && scroller) {
        positions.set(presentedKey, scroller.scrollTop);
      }
    },
    restore() {
      if (!host.isConnected) {
        return;
      }
      const next = key();
      if (next !== presentedKey) {
        presentedKey = next;
        if (scroller) {
          scroller.scrollTop = positions.get(next) ?? 0;
        }
      }
      observation?.schedule();
    },
    onScroll: () => {
      if (scroller) {
        positions.set(presentedKey, scroller.scrollTop);
      }
    },
  };
}
