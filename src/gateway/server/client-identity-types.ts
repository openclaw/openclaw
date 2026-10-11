/** Server-attested identity facts shared by RPC and transport client records. */
import type { RemoteControlUiIngressContext } from "../remote-control-ui-context.js";

export type GatewayWsBrowserOrigin = {
  requestHost?: string;
  origin?: string;
  isLocalClient?: boolean;
  remoteControlUiIngress?: RemoteControlUiIngressContext;
};
