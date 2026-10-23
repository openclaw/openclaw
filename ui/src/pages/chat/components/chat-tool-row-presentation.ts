import type { ToolCardOutcome } from "../../../lib/chat/chat-types.ts";
import type { ToolCallView } from "../../../lib/chat/tool-call-view.ts";
import { t } from "../../../lib/reactive/i18n.ts";

const TOOL_ROW_VERB_KEYS: Partial<Record<ToolCallView["kind"], string>> = {
  read: "chat.toolCards.verbs.read",
  search: "chat.toolCards.verbs.searched",
  fetch: "chat.toolCards.verbs.fetched",
};

const MUTATION_VERB_KEYS = {
  update: ["editing", "edited", "edit"],
  add: ["creating", "created", "create"],
  delete: ["deleting", "deleted", "delete"],
  mixed: ["changing", "changed", "change"],
  write: ["writing", "wrote", "write"],
} as const;

function resolveMutationVerbKind(
  view: Pick<ToolCallView, "kind" | "fileOperations">,
): keyof typeof MUTATION_VERB_KEYS | undefined {
  if (view.kind === "write") {
    return "write";
  }
  if (view.kind !== "edit") {
    return undefined;
  }
  const operations = new Set(view.fileOperations?.map(({ operation }) => operation));
  return operations.size > 1 ? "mixed" : (operations.values().next().value ?? "update");
}

export function resolveToolRowVerb(
  view: Pick<ToolCallView, "kind" | "fileOperations">,
  outcome: ToolCardOutcome,
): string | undefined {
  const mutation = resolveMutationVerbKind(view);
  if (mutation) {
    const [running, succeeded, fallback] = MUTATION_VERB_KEYS[mutation];
    return t(
      `chat.toolCards.verbs.${outcome === "running" ? running : outcome === "succeeded" ? succeeded : fallback}`,
    );
  }
  const key = TOOL_ROW_VERB_KEYS[view.kind];
  return key ? t(key) : undefined;
}
