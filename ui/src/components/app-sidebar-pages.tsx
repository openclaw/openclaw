import { lazy } from "solid-js";

const loadPages = () => import("./app-sidebar-pages.runtime.tsx");

export const SidebarPagesMenu = lazy(loadPages, { export: "SidebarPagesMenu" });
export const SidebarPluginSection = lazy(loadPages, { export: "SidebarPluginSection" });
