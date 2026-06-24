import { createContext } from "@lit/context";
import type { GatewayBrowserClient, GatewayEventListener, GatewayHelloOk } from "../api/gateway.ts";
import type { RouteId } from "../app-routes.ts";
import type { SessionCapability } from "../lib/sessions/index.ts";
import type { RouteLocation } from "../router/types.ts";
import type { ApplicationOverlays } from "./overlays.ts";
import type { ThemeMode } from "./theme.ts";

export type ApplicationGatewaySnapshot = {
  client: GatewayBrowserClient | null;
  connected: boolean;
  hello: GatewayHelloOk | null;
  assistantAgentId: string | null;
  sessionKey: string;
  lastError: string | null;
  lastErrorCode: string | null;
};

export type ApplicationGatewayConnection = {
  gatewayUrl: string;
  token: string;
  password: string;
};

export type ApplicationGateway = {
  readonly snapshot: ApplicationGatewaySnapshot;
  readonly connection: ApplicationGatewayConnection;
  connect: (connection?: Partial<ApplicationGatewayConnection>) => void;
  start: () => void;
  stop: () => void;
  subscribe: (listener: (snapshot: ApplicationGatewaySnapshot) => void) => () => void;
  subscribeEvents: (listener: GatewayEventListener) => () => void;
};

export type ApplicationTheme = {
  readonly mode: ThemeMode;
  setMode: (mode: ThemeMode, element?: HTMLElement | null) => void;
};

export type ApplicationNavigationPreferencesSnapshot = {
  navCollapsed: boolean;
  navGroupsCollapsed: Record<string, boolean>;
  recentSessionsCollapsed: boolean;
};

export type ApplicationNavigationPreferences = {
  readonly snapshot: ApplicationNavigationPreferencesSnapshot;
  update: (patch: Partial<ApplicationNavigationPreferencesSnapshot>) => void;
  subscribe: (listener: (snapshot: ApplicationNavigationPreferencesSnapshot) => void) => () => void;
};

export type ApplicationNavigationOptions = Pick<RouteLocation, "search" | "hash">;

export type ApplicationContext<TRouteId extends string = string> = {
  readonly basePath: string;
  readonly assistantName: string;
  readonly gateway: ApplicationGateway;
  readonly sessions: SessionCapability;
  readonly overlays: ApplicationOverlays;
  readonly navigation: ApplicationNavigationPreferences;
  readonly theme: ApplicationTheme;
  readonly navigate: (routeId: TRouteId, options?: ApplicationNavigationOptions) => void;
  readonly replace: (routeId: TRouteId, options?: ApplicationNavigationOptions) => void;
  readonly preload: (routeId: TRouteId) => Promise<void>;
};

export const applicationContext =
  createContext<ApplicationContext<RouteId>>("openclaw.application");
