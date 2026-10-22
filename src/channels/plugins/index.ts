// Runtime channel-plugin entrypoint for registry and approval helpers.
// Keep the channel identity type export narrow; broader SDK barrels live elsewhere.
export {
  getChannelPlugin,
  getLoadedChannelPlugin,
  listChannelPlugins,
  normalizeChannelId,
} from "./registry.js";
export type { ChannelId } from "./types.public.js";
export { resolveChannelApprovalAdapter, resolveChannelApprovalCapability } from "./approvals.js";
