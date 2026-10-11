/** Server-attested identity facts shared by RPC and transport client records. */
export type GatewayWsBrowserOrigin = {
  requestHost?: string;
  origin?: string;
  isLocalClient?: boolean;
};
