import { normalizeOptionalLowercaseString } from "@openclaw/normalization-core/string-coerce";
import type { NodeRegistry, NodeSession } from "./node-registry.js";

const TALK_CAPABILITY = "talk";
const TALK_COMMAND_PREFIX = "talk.";

/** Returns true when any connected node can handle Talk capture/PTT commands. */
export function hasConnectedTalkNode(registry: NodeRegistry): boolean {
  return registry.listConnected().some(isTalkCapableNode);
}

function isTalkCapableNode(node: NodeSession): boolean {
  // Nodes can advertise Talk support either as a broad capability or as specific
  // talk.* commands; accept both so older and newer node manifests work.
  return (
    node.caps.some(
      (capability) => normalizeOptionalLowercaseString(capability) === TALK_CAPABILITY,
    ) ||
    node.commands.some((command) =>
      normalizeOptionalLowercaseString(command)?.startsWith(TALK_COMMAND_PREFIX),
    )
  );
}
