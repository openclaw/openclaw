/**
 * Channel health module exports.
 */

export {
  type ChannelHealthStatus,
  type ChannelHealth,
  type ChannelHealthProvider,
  type ChannelHealthRegistry,
  type ChannelHealthSummary,
  createChannelHealthRegistry,
  createBasicHealthProvider,
  DEFAULT_HEALTH_CHECK_INTERVAL_MS,
} from "./channel-health.js";
