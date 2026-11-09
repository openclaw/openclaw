import { createContext, createSignal } from "solid-js";
import { elementRef } from "../lib/reactive/element-ref.ts";
import type { AppSidebarBase } from "./app-sidebar-base.ts";
import type { SidebarSessionsScrollState } from "./app-sidebar-session-types.ts";
import { observeScrollState } from "./scroll-state-observer.ts";

export const SidebarScrollContext = createContext<{
  element(): HTMLElement | undefined;
  content(): HTMLElement | undefined;
  rowFloor(): number;
  captureRowFloor(value: number): void;
  registerWindow(read: () => readonly string[] | undefined): () => void;
  readAnchor(): { key: string; offset: number } | undefined;
  captureAnchor(anchor: { key: string; offset: number }): void;
  subscribeScroll(listener: () => void): () => void;
} | null>(null);

/** Preserve the shared sidebar's scroll position for each destination. */
export function createSidebarScroll(
  host: Pick<
    AppSidebarBase,
    "isConnected" | "navigationView" | "contextualSidebar" | "sidebarSnapshot"
  > & { readonly snapshot: { capture(): void } },
) {
  const positions = new Map<string, number>();
  const anchors = new Map<string, { key: string; offset: number }>();
  const scrollListeners = new Set<() => void>();
  const windows = new Set<() => readonly string[] | undefined>();
  let rowFloor: number | undefined;
  const [state, setState] = createSignal<SidebarSessionsScrollState>("none");
  let presentedKey = "sessions";
  let scroller: HTMLElement | undefined;
  let content: HTMLElement | undefined;
  let observation: ReturnType<typeof observeScrollState> | undefined;
  const key = () =>
    host.navigationView === "sessions"
      ? (host.contextualSidebar?.key ?? "sessions")
      : host.navigationView;
  return {
    state,
    rowFloor: () => rowFloor ?? host.sidebarSnapshot?.rowFloor ?? 32,
    captureRowFloor(value: number) {
      rowFloor = value;
      host.snapshot.capture();
    },
    registerWindow(read: () => readonly string[] | undefined) {
      windows.add(read);
      return () => {
        windows.delete(read);
      };
    },
    windowKeys() {
      const keys = new Set<string>();
      for (const read of windows) {
        const sessionKeys = read();
        if (!sessionKeys) {
          return undefined;
        }
        for (const sessionKey of sessionKeys) {
          keys.add(sessionKey);
        }
      }
      return [...keys];
    },
    element: () => scroller,
    content: () => content,
    createContentRef() {
      return elementRef((element: HTMLElement) => {
        content = element;
        return () => {
          if (content === element) {
            content = undefined;
          }
        };
      });
    },
    readAnchor: () => anchors.get(key()),
    captureAnchor: (anchor: { key: string; offset: number }) => anchors.set(presentedKey, anchor),
    subscribeScroll(listener: () => void) {
      scrollListeners.add(listener);
      return () => {
        scrollListeners.delete(listener);
      };
    },
    createRef() {
      // The frame can disappear while its containing sidebar retains destination offsets.
      return elementRef((element: HTMLElement) => {
        scroller = element;
        const bound = observeScrollState(element, (next) =>
          setState(
            !next.scrollable ? "none" : next.atStart ? "top" : next.atEnd ? "bottom" : "middle",
          ),
        );
        observation = bound;
        return () => {
          bound.disconnect();
          if (observation === bound) {
            observation = undefined;
            scroller = undefined;
          }
        };
      });
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
        anchors.delete(presentedKey);
        for (const listener of scrollListeners) {
          listener();
        }
      }
    },
  };
}
