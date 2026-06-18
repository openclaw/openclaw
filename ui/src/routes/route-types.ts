import type { SettingsAppHost, SettingsHost } from "../app/app-host.ts";
import type { AppViewState } from "../ui/app-view-state.ts";
import type { IconName } from "../ui/icons.js";

export interface RouteRecord<TRouteId extends string = string> {
  path: string;
  icon: IconName;
  titleKey: string;
  subtitleKey: string;
  parent?: TRouteId;
}

export type RouteRefreshOptions = { chatStartup?: boolean };

export type RouteRefresh = (context: {
  host: SettingsHost;
  app: SettingsAppHost;
  opts?: RouteRefreshOptions;
}) => void | Promise<void>;

export type RouteModule<TRouteId extends string = string> = {
  id: TRouteId;
  refresh?: RouteRefresh;
  contentClass?: (state: AppViewState) => string;
  renderHeaderControls?: (state: AppViewState) => unknown;
  renderView?: (state: AppViewState) => unknown;
};
