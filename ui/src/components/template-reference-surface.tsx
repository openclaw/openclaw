import type { GatewayBrowserClient } from "../api/gateway.ts";
import type { ApplicationContext } from "../app/context.ts";

export type TemplateReference = {
  anchor: HTMLAnchorElement;
  client: GatewayBrowserClient;
  sessionKey: string;
  type: string;
};

export type TemplateReferenceSource = () => {
  applicationContext?: ApplicationContext;
  gatewayClient?: GatewayBrowserClient | null;
  sessionKey: string;
};
