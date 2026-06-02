import { normalizeOptionalLowercaseString } from "@openclaw/normalization-core/string-coerce";
import type { NodeRegistry, NodeSession } from "./node-registry.js";

const TALK_CAPABILITY = "talk";
const TALK_COMMAND_PREFIX = "talk.";

/** Returns true when any connected node advertises Talk capability or Talk commands. */
export function hasConnectedTalkNode(registry: NodeRegistry): boolean {
  return registry.listConnected().some(isTalkCapableNode);
}

function isTalkCapableNode(node: NodeSession): boolean {
  // Some nodes expose a broad capability while older/custom nodes expose only
  // talk.* commands, so accept either advertisement.
  return (
    node.caps.some(
      (capability) => normalizeOptionalLowercaseString(capability) === TALK_CAPABILITY,
    ) ||
    node.commands.some((command) =>
      normalizeOptionalLowercaseString(command)?.startsWith(TALK_COMMAND_PREFIX),
    )
  );
}
