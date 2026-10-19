import type { JSX } from "@solidjs/web";
import type { ApplicationContext } from "../app/context-types.ts";

export type SidebarAttentionElementAttributes = JSX.HTMLAttributes<HTMLElement> & {
  "prop:onNavigate"?: ApplicationContext["navigate"];
};
