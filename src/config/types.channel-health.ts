import type { z } from "zod";
import type { ChannelHealthMonitorSchema } from "./zod-schema.channels.js";

/** @deprecated Doctor input only; visibility is migrated into automation delivery policy. */
export type ChannelHeartbeatVisibilityConfig = {
  showOk?: boolean;
  showAlerts?: boolean;
  useIndicator?: boolean;
};
export type ChannelHealthMonitorConfig = NonNullable<z.input<typeof ChannelHealthMonitorSchema>>;
