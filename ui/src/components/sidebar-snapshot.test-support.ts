import { sidebarBootSnapshot } from "../test-helpers/sidebar-boot-snapshot.test-support.ts";
import type { SidebarSnapshotModel } from "./sidebar-snapshot-model.ts";

export const sidebarSnapshot: SidebarSnapshotModel = {
  ...sidebarBootSnapshot(null),
  footer: { id: "operator", name: "Riley" },
  brand: { name: "Harbor", avatar: null, icon: "claw", environment: null },
};
