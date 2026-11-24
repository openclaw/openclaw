import { createContext, useContext } from "solid-js";

export type SidebarAttentionFocusKind = "control" | "row" | "row-only";
export type SidebarAttentionFocus = {
  /** For elements owned by a child, such as a menu trigger, that live as long as the panel. */
  add(element: HTMLElement, kind?: SidebarAttentionFocusKind): void;
  ref(kind?: SidebarAttentionFocusKind): (element: HTMLElement) => void;
  rows(): HTMLElement[];
  controls(): HTMLElement[];
};

export const SidebarAttentionFocusContext = createContext<SidebarAttentionFocus | null>(null);

/** Shared row renderers also appear outside the Inbox, where no registration is needed. */
export function sidebarAttentionFocusRef(kind: SidebarAttentionFocusKind = "control") {
  return useContext(SidebarAttentionFocusContext)?.ref(kind);
}
