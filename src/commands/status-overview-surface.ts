import type { buildStatusOverviewSurfaceRows } from "./status-all/format.js";
import type { NodeOnlyGatewayInfo } from "./status.node-mode.js";

type StatusOverviewRowInput = Parameters<typeof buildStatusOverviewSurfaceRows>[0];
type StatusOverviewFormatOptions = Pick<
  StatusOverviewRowInput,
  | "includeBackendStateWhenOn"
  | "includeDnsNameWhenOff"
  | "decorateTailscaleOff"
  | "decorateTailscaleWarn"
  | "decorateOk"
  | "decorateWarn"
  | "prefixRows"
  | "middleRows"
  | "suffixRows"
  | "agentsValue"
  | "updateValue"
  | "gatewayAuthWarningValue"
  | "gatewaySelfFallbackValue"
>;

export type StatusOverviewSurface = Omit<
  StatusOverviewRowInput,
  keyof StatusOverviewFormatOptions | "nodeOnlyGateway"
> & {
  nodeOnlyGateway?: NodeOnlyGatewayInfo | null;
};
