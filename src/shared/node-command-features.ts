import { Value } from "typebox/value";
import {
  NodeCommandFeaturesPayloadSchema,
  type NodeCommandFeaturesPayload,
} from "../../packages/gateway-protocol/src/schema/nodes.js";

export const NODE_COMMAND_FEATURES_EVENT = "node.command.features";
export function isNodeCommandFeaturesPayload(value: unknown): value is NodeCommandFeaturesPayload {
  return Value.Check(NodeCommandFeaturesPayloadSchema, value);
}
