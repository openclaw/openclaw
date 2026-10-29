import type { SchemaContract } from "../../packages/gateway-protocol/src/schema-contract.js";
import type {
  ErrorShape,
  ResponseFrame,
} from "../../packages/gateway-protocol/src/schema/frames.js";

export type GatewayMethodDispatchResponse = SchemaContract<
  Omit<ResponseFrame, "type" | "id" | "error">
> & {
  error?: ErrorShape;
  meta?: Record<string, unknown>;
};
