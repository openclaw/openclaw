import type { EventLogEntry } from "../api/event-log.ts";
import type { GatewayBrowserClient, GatewayEventListener, GatewayHelloOk } from "../api/gateway.ts";

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

export type ApplicationGatewayConnectOptions = Partial<ApplicationGatewayConnection> & {
  sessionKey?: string;
};

export type ApplicationGateway = {
  readonly snapshot: ApplicationGatewaySnapshot;
  readonly connection: ApplicationGatewayConnection;
  readonly eventLog: readonly EventLogEntry[];
  connect: (connection?: ApplicationGatewayConnectOptions) => void;
  setSessionKey: (sessionKey: string) => void;
  start: () => void;
  stop: () => void;
  subscribe: (listener: (snapshot: ApplicationGatewaySnapshot) => void) => () => void;
  subscribeEventLog: (listener: (events: readonly EventLogEntry[]) => void) => () => void;
  subscribeEvents: (listener: GatewayEventListener) => () => void;
};
