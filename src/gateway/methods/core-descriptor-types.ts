import type {
  GatewayMethodDescriptor,
  GatewayMethodScope,
  GatewayMethodSessionAccess,
} from "./descriptor.js";
export type CoreGatewayMethodSpec = {
  name: string;
  family?: string;
  scope: GatewayMethodScope;
  since?: string;
  advertise?: false;
  startup?: true;
  lifetime?: GatewayMethodDescriptor["lifetime"];
  controlPlaneWrite?: true;
  compatibilityRestored?: true;
  description?: string;
  sessionAccess?: GatewayMethodSessionAccess;
};

type CoreGatewayMethodPolicy = Pick<
  CoreGatewayMethodSpec,
  | "advertise"
  | "startup"
  | "lifetime"
  | "controlPlaneWrite"
  | "compatibilityRestored"
  | "description"
  | "sessionAccess"
>;
export type CoreGatewayMethodSpecRow = readonly [
  name: string,
  family: string | null,
  scope: GatewayMethodScope,
  since: string,
  policy?: CoreGatewayMethodPolicy,
];
