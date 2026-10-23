import { areUiSessionKeysEquivalent } from "../../../lib/sessions/session-key.ts";
import type { ChatSwarmProgressProps } from "./chat-swarm-progress-types.ts";

export function resolveChatSwarmParent(props: ChatSwarmProgressProps) {
  return props.sessions.find(
    (row) =>
      areUiSessionKeysEquivalent(row.key, props.sessionKey) &&
      ((props.sessionKey !== "global" && props.sessionKey !== "unknown") ||
        Boolean(props.agentId && row.agentId === props.agentId)),
  );
}
