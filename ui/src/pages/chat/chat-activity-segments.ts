import type { ToolCard } from "../../lib/chat/chat-types.ts";
import { getExplicitToolExpansion } from "./chat-thread.ts";
import { isInlineCommandCard } from "./components/chat-activity-operations.ts";

/** Inline presentation overrides defaults without changing grouped disclosure state. */
export function readInlineToolExpansion(
  expanded: ReadonlyMap<string, boolean>,
  id: string,
  card?: ToolCard,
) {
  return (
    getExplicitToolExpansion(expanded, id) ??
    (card && isInlineCommandCard(card) ? false : expanded.get(id))
  );
}
