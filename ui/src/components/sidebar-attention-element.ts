import type { JSX } from "@solidjs/web";
import type { ApplicationContext } from "../app/context-types.ts";
import type { SidebarAttentionElement } from "./sidebar-attention.tsx";

declare global {
  interface HTMLElementTagNameMap {
    "openclaw-sidebar-attention": SidebarAttentionElement;
  }
}

export type SidebarAttentionElementAttributes = JSX.HTMLAttributes<HTMLElement> & {
  "prop:onNavigate"?: ApplicationContext["navigate"];
};
