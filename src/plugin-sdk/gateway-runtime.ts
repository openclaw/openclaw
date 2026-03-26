// Public gateway/client helpers for plugins that talk to the host gateway surface.

export { callGateway } from "../gateway/call.js";
export * from "../gateway/channel-status-patches.js";
export { GatewayClient } from "../gateway/client.js";
export { createOperatorApprovalsGatewayClient } from "../gateway/operator-approvals-client.js";
export type { EventFrame } from "../gateway/protocol/index.js";
export { GATEWAY_CLIENT_MODES, GATEWAY_CLIENT_NAMES } from "../utils/message-channel.js";
