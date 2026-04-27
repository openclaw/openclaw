import { z } from "zod";
import type { ChannelsConfig } from "./types.channels.js";
export * from "./zod-schema.providers-core.js";
export * from "./zod-schema.providers-whatsapp.js";
export { ChannelHeartbeatVisibilitySchema } from "./zod-schema.channels.js";
export declare const ChannelsSchema: z.ZodType<ChannelsConfig | undefined>;
