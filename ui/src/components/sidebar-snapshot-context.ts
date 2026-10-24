import { createContext, type Accessor } from "solid-js";
import type { SidebarSnapshotModel } from "./sidebar-snapshot-model.ts";

/** Cached display facts belong to the sidebar, never the live agent capabilities. */
export const SidebarSnapshotContext = createContext<Accessor<SidebarSnapshotModel | null> | null>(
  null,
);
