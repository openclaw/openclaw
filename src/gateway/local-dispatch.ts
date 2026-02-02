import type { GatewayClientMode, GatewayClientName } from "../utils/message-channel.js";

export type LocalGatewayDispatchOptions = {
  method: string;
  params?: unknown;
  clientName?: GatewayClientName;
  clientDisplayName?: string;
  clientVersion?: string;
  platform?: string;
  mode?: GatewayClientMode;
  instanceId?: string;
};

export type LocalGatewayDispatcher = (opts: LocalGatewayDispatchOptions) => Promise<unknown>;

let localDispatcher: LocalGatewayDispatcher | null = null;

export function setLocalGatewayDispatcher(dispatcher: LocalGatewayDispatcher | null) {
  localDispatcher = dispatcher;
}

export function getLocalGatewayDispatcher(): LocalGatewayDispatcher | null {
  return localDispatcher;
}
