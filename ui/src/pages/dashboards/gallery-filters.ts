import type { ApplicationContext } from "../../app/context.ts";
import type { DashboardsDisplay } from "../../app/settings-contract.ts";

export type DashboardGalleryFilters = DashboardsDisplay & {
  query: string;
  ownerId: string;
};

export type DashboardGalleryHandlers = {
  onFilterChange: (filter: Partial<DashboardGalleryFilters>) => void;
  onNavigate?: ApplicationContext["navigate"];
};
