import type { AgentsListResult, SessionsListResult } from "../../api/types.ts";
import type { ApplicationContext } from "../../app/context.ts";
import type { DashboardsDisplay } from "../../app/settings-contract.ts";

export type DashboardGalleryFilters = DashboardsDisplay & {
  query: string;
  ownerIds: string[];
};

export type DashboardGalleryHandlers = {
  onFilterChange: (filter: Partial<DashboardGalleryFilters>) => void;
  onNavigate?: ApplicationContext["navigate"];
};

export type DashboardsRouteData = {
  result: SessionsListResult | null;
  error: string | null;
  basePath: string;
  fallbackAgentId: string;
  /** The agent roster, for agent authors' names. */
  agents: AgentsListResult["agents"];
  mainKey: string;
  globalScope: boolean;
};
