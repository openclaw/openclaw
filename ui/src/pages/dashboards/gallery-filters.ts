import type { ApplicationContext } from "../../app/context.ts";

export type DashboardGalleryFilters = {
  query: string;
  ownerId: string;
  sort: "updated" | "title";
};

export type DashboardGalleryHandlers = {
  onFilterChange: (filter: Partial<DashboardGalleryFilters>) => void;
  onNavigate?: ApplicationContext["navigate"];
};
