import type { GatewayBrowserClient, GatewayHelloOk } from "../api/gateway.ts";
import type { Router } from "../router/types.ts";
import type { RouterOutletSelection, RouterOutletSnapshotStore } from "./router-outlet.ts";
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
};

export type ApplicationTheme = {
  readonly mode: ThemeMode;
  setMode: (mode: ThemeMode, element?: HTMLElement | null) => void;
};

export type ApplicationPageContext<TRouteId extends string = string> = {
  readonly basePath: string;
  readonly assistantName: string;
  readonly gateway: ApplicationGateway;
  readonly theme: ApplicationTheme;
  readonly navigate: (routeId: TRouteId) => void;
  readonly preload: (routeId: TRouteId) => Promise<void>;
};

export type StableApplicationContext<
  TRouteId extends string = string,
  TModule = unknown,
  TData = unknown,
> = ApplicationPageContext<TRouteId> & {
  readonly router: Router<TRouteId, ApplicationPageContext<TRouteId>, TModule, TData>;
  readonly routeSnapshot: RouterOutletSnapshotStore<TRouteId, TModule, TData>;
  readonly dispose: () => void;
};

export type ApplicationRouteSelection<
  TRouteId extends string = string,
  TModule = unknown,
  TData = unknown,
> = RouterOutletSelection<TRouteId, TModule, TData>;
