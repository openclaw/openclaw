import type { ApplicationContext } from "../../app/context.ts";

export type DashboardGalleryFilters = {
  query: string;
  ownerIds: string[];
  sort: "updated" | "title";
};

export type DashboardGalleryHandlers = {
  onFilterChange: (filter: Partial<DashboardGalleryFilters>) => void;
  onNavigate?: ApplicationContext["navigate"];
};
