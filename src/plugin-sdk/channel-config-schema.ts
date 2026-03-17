/** Shared config-schema primitives for channel plugins with DM/group policy knobs. */
export {
  AllowFromListSchema,
  buildCatchallMultiAccountChannelSchema,
  buildNestedDmConfigSchema,
} from "../channels/plugins/config-schema.js";
export { DmPolicySchema, GroupPolicySchema } from "../config/zod-schema.core.js";
