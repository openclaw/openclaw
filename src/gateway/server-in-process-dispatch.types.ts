import type { ResponseFrame } from "../../packages/gateway-protocol/src/schema/frames.js";

export type GatewayMethodDispatchResponse = Omit<ResponseFrame, "type" | "id"> & {
  meta?: Record<string, unknown>;
};
