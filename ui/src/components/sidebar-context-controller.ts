import { createContext, createSignal } from "solid-js";
import { elementRef } from "../lib/reactive/element-ref.ts";
import { createLayoutMeasurement } from "../lib/reactive/layout-measurement.ts";
import { observeResize } from "../lib/reactive/observers.ts";
import type { AppSidebarOwner } from "./app-sidebar-owner.tsx";
import type { SidebarSessionsScrollState } from "./app-sidebar-session-types.ts";
import { readScrollState, type ScrollState } from "./scroll-state-observer.ts";

export const SidebarScrollContext = createContext<{
  element(): HTMLElement | undefined;
  content(): HTMLElement | undefined;
  top(): number;
  rowFloor(): number;
  captureRowFloor(value: number): void;
  readAnchor(): { key: string; offset: number } | undefined;
  captureAnchor(anchor: { key: string; offset: number }): void;
  subscribeScroll(listener: () => void): () => void;
} | null>(null);

/** Preserve the shared sidebar's scroll position for each destination. */
export function createSidebarScroll(
  host: Pick<
    AppSidebarOwner,
    "isConnected" | "navigationView" | "contextualSidebar" | "sidebarSnapshot" | "snapshot"
  >,
) {
  const positions = new Map<string, number>();
  const anchors = new Map<string, { key: string; offset: number }>();
  const scrollListeners = new Set<() => void>();
  const [state, setState] = createSignal<SidebarSessionsScrollState>("none");
  // Cached DOM can bind after this owner's initial settle.
  const [viewportRevision, setViewportRevision] = createSignal(0);
  let presentedKey = "sessions";
  let scroller: HTMLElement | undefined;
  let content: HTMLElement | undefined;
  let pendingTop: number | undefined;
  let knownRowFloor: number | undefined;
  const key = () =>
    host.navigationView === "sessions"
      ? (host.contextualSidebar?.key ?? "sessions")
      : host.navigationView;
  // Window selection uses the saved offset until the shared layout pass applies it.
  const top = () => pendingTop ?? scroller?.scrollTop ?? 0;
  const publish = (next: ScrollState) =>
    setState(!next.scrollable ? "none" : next.atStart ? "top" : next.atEnd ? "bottom" : "middle");
  const measure = createLayoutMeasurement(
    () => {
      viewportRevision();
      return key();
    },
    () => {
      const element = scroller;
      if (!element || pendingTop !== undefined) {
        return undefined;
      }
      const next = readScrollState(element);
      return () => {
        if (scroller !== element) {
          return;
        }
        publish(next);
      };
    },
    {
      targets: () => (scroller ? [scroller, ...(content ? [content] : [])] : []),
      fonts: true,
    },
  );
  return {
    state,
    top,
    rowFloor: () => knownRowFloor ?? host.sidebarSnapshot?.rowFloor ?? 32,
    captureRowFloor: (value: number) => (knownRowFloor = value),
    element: () => scroller,
    content: () => content,
    createContentRef() {
      return elementRef((element: HTMLElement) => {
        content = element;
        setViewportRevision((revision) => revision + 1);
        return () => {
          if (content === element) {
            content = undefined;
            setViewportRevision((revision) => revision + 1);
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
        presentedKey = key();
        // Zero needs no native write; it would still synchronously flush dirty layout.
        pendingTop =
          Math.max(0, host.sidebarSnapshot?.scrollTop ?? positions.get(presentedKey) ?? 0) ||
          undefined;
        // Native resize delivery follows layout and restores before this frame paints.
        const stopRestore =
          pendingTop === undefined
            ? undefined
            : observeResize([element], () => {
                if (!element.isConnected || pendingTop === undefined) {
                  return;
                }
                const next = readScrollState(element, false, pendingTop);
                element.scrollTop = pendingTop;
                pendingTop = undefined;
                publish(next);
                stopRestore?.();
              });
        setViewportRevision((revision) => revision + 1);
        return () => {
          stopRestore?.();
          if (scroller === element) {
            scroller = undefined;
            pendingTop = undefined;
            setViewportRevision((revision) => revision + 1);
          }
        };
      });
    },
    capture() {
      if (host.isConnected && key() !== presentedKey && scroller) {
        positions.set(presentedKey, top());
      }
    },
    restore() {
      if (!host.isConnected) {
        return;
      }
      const next = key();
      if (next !== presentedKey) {
        presentedKey = next;
        pendingTop = undefined;
        if (scroller) {
          scroller.scrollTop = positions.get(next) ?? 0;
        }
      }
      measure();
    },
    onScroll: () => {
      if (scroller) {
        measure();
        positions.set(presentedKey, scroller.scrollTop);
        anchors.delete(presentedKey);
        for (const listener of scrollListeners) {
          listener();
        }
        host.snapshot.capture();
      }
    },
  };
}
