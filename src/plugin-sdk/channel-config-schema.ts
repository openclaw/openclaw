/** Shared config-schema primitives for channel plugins with DM/group policy knobs. */
export {
  AllowFromListSchema,
  buildChannelConfigSchema,
  buildCatchallMultiAccountChannelSchema,
  buildNestedDmConfigSchema,
} from "../channels/plugins/config-schema.js";
export {
  DmPolicySchema,
  GroupPolicySchema,
  MarkdownConfigSchema,
} from "../config/zod-schema.core.js";
export { ToolPolicySchema } from "../config/zod-schema.agent-runtime.js";
export { SlackConfigSchema } from "../config/zod-schema.providers-core.js";
