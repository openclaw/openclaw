import { SESSIONS_SEND_RESULT_GUIDANCE } from "../tool-description-presets.js";
export {
  PlacedSessionsSpawnSchema,
  PlacedSessionsSendSchema,
  type PlacedSessionsSpawnArguments,
  type PlacedSessionsSendArguments,
} from "../../../packages/gateway-protocol/src/schema/worker-session-tools.js";

export const PLACED_SESSIONS_SPAWN_DESCRIPTION =
  "Spawn a visible cloud child session in a fresh managed worktree. The child inherits the current cloud placement profile and attenuated tool policy.";
export const PLACED_SESSIONS_SEND_DESCRIPTION = `Send a message to an authorized parent, child, or sibling session on this Gateway, whether it runs on the Gateway, a paired device, or a cloud worker. Cross-tree and stale-incarnation targets are denied by the Gateway. ${SESSIONS_SEND_RESULT_GUIDANCE} Status "no_reply" is terminal; do not wait for another result.`;
