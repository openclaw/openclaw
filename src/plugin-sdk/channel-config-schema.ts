/** Shared config-schema primitives for channel plugins with DM/group policy knobs. */
export {
  AllowFromListSchema,
  buildCatchallMultiAccountChannelSchema,
  buildChannelConfigSchema,
  buildNestedDmConfigSchema,
} from "../channels/plugins/config-schema.js";
export {
  DmPolicySchema,
  GroupPolicySchema,
  MarkdownConfigSchema,
} from "../config/zod-schema.core.js";
