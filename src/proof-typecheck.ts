/**
 * Type-level proof: attempt to call listChannelAgentTools with sender params.
 * On upstream/main: TypeScript ERROR (params not in signature).
 * On PR branch: compiles cleanly.
 */
import { listChannelAgentTools } from "./agents/channel-tools.js";
import type { OpenClawConfig } from "./config/config.js";

// Attempt to pass sender context to the channel tools aggregator.
const tools = listChannelAgentTools({
  cfg: {} as OpenClawConfig,
  requesterSenderId: "user-42",
  senderIsOwner: false,
});

console.log("Type check passed. Tools returned:", tools.length);
