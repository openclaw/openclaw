// Defines channel heartbeat and health visibility configuration types.
import type { z } from "zod";
import type {
  ChannelHealthMonitorSchema,
  ChannelHeartbeatVisibilitySchema,
} from "./zod-schema.channels.js";

export type ChannelHeartbeatVisibilityConfig = NonNullable<
  z.input<typeof ChannelHeartbeatVisibilitySchema>
>;
export type ChannelHealthMonitorConfig = NonNullable<z.input<typeof ChannelHealthMonitorSchema>>;
