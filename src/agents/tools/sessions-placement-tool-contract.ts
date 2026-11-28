import { SESSIONS_SEND_RESULT_GUIDANCE } from "../tool-description-presets.js";
export {
  PlacedSessionsSpawnSchema,
  PlacedSessionsSendSchema,
  type PlacedSessionsSpawnArguments,
  type PlacedSessionsSendArguments,
} from "../../../packages/gateway-protocol/src/schema/worker-session-tools.js";

export const PLACED_SESSIONS_SPAWN_DESCRIPTION =
  "Spawn a visible cloud child session in a fresh managed worktree. The child inherits the current cloud placement profile and attenuated tool policy. The whole brief (objective, output, write scope, verification) goes in task; label is for UI. Use for delegated child work, not independent session creation. Follow the receipt's accepted completion mode and synthesize child outputs. Never loop-poll subagents list or sessions_list; check status only on demand, debug, or intervention.";
export const PLACED_SESSIONS_SEND_DESCRIPTION = `Send a message to an authorized parent, child, or sibling session on this Gateway, whether it runs on the Gateway, a paired device, or a cloud worker. Cross-tree and stale-incarnation targets are denied by the Gateway. Ordinary peer sends start a separate turn and may wait behind active work; timeoutSeconds bounds reply waiting. A send to your own busy child steers its active run without a separate completion turn; a zero-wait send to an eligible run-scoped target may use its active input queue. Idle recipients start a new turn. ${SESSIONS_SEND_RESULT_GUIDANCE} Status "no_reply" is terminal; do not wait for another result.`;
