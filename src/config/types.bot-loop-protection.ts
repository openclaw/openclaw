// Defines channel bot-loop protection configuration types.
import type { z } from "zod";
import type { ChannelBotLoopProtectionSchema } from "./zod-schema.channel-bot-loop.js";

export type ChannelBotLoopProtectionConfig = z.input<typeof ChannelBotLoopProtectionSchema>;
