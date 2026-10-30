import type { z } from "zod";
import type { ChannelImplicitMentionsSchema } from "./zod-schema.implicit-mentions.js";

export type ChannelImplicitMentionsConfig = z.input<typeof ChannelImplicitMentionsSchema>;
