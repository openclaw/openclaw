import { asNullableRecord } from "@openclaw/normalization-core/record-coerce";
import { summarizeAgentActivity } from "../../../../../src/agents/agent-activity-presentation.js";
import type { ControlUiSurfaceProps } from "../../../../../src/plugin-sdk/control-ui.js";
import type { ToolCard } from "../../../lib/chat/chat-types.ts";
import type { ToolCallView } from "../../../lib/chat/tool-call-view.ts";
import { isToolCardError, isToolCardSkipped } from "../../../lib/chat/tool-cards.ts";
import type { SubagentRowContext } from "../chat-spawned-subagent.ts";
import type { PluginToolIcons } from "../chat-tool-icon-controller.ts";
import type { SidebarContent } from "./chat-sidebar-content-types.ts";

export function summarizeToolCardOutcomes(
  cards: readonly ToolCard[],
  activity?: Parameters<typeof summarizeAgentActivity>[0],
) {
  const failures = cards.filter(isToolCardError);
  // Prepared outcomes remain authoritative even when their raw card is absent.
  const outcomes = activity ? summarizeAgentActivity(activity).outcomes : undefined;
  return {
    failed: outcomes?.failed ?? failures.length,
    skipped: outcomes?.skipped ?? cards.filter(isToolCardSkipped).length,
    exitCode: failures[0]?.exitCode,
  };
}

export function toolWorkspacePath(card: ToolCard, view: ToolCallView): string | null {
  if (view.kind !== "read" && view.kind !== "edit" && view.kind !== "write") {
    return null;
  }
  const singleOperation = view.fileOperations?.length === 1 ? view.fileOperations[0] : undefined;
  // A delete removes its own target, so the workspace loader would always
  // report "Failed to load"; the row keeps its disclosure but no file action.
  if (singleOperation?.operation === "delete") {
    return null;
  }
  const args = asNullableRecord(card.args);
  if (args) {
    for (const key of ["path", "file_path", "filePath", "notebook_path"]) {
      const value = args[key];
      if (typeof value === "string" && value.trim()) {
        return value;
      }
    }
  }
  const fallback = `${view.targetDetail ? `${view.targetDetail}/` : ""}${view.target ?? ""}`;
  const fallbackPath = fallback.trim();
  // Aggregate patch labels ("2 files", "a.ts → b.ts") name no single file, so
  // only a recorded operation matching the rendered path stays navigable.
  if (view.fileOperations) {
    return singleOperation?.path === fallbackPath ? singleOperation.path : null;
  }
  return fallbackPath || null;
}

export type ToolRenderOptions = {
  pluginToolIcons?: PluginToolIcons;
  messageKey: string;
  sessionKey?: string;
  agentId?: string;
  presented?: boolean;
  runActive?: boolean;
  onOpenSidebar?: (content: SidebarContent) => void;
  onOpenWorkspaceFile?: (target: { path: string; line?: number | null }) => void;
  onPermissionRetry?: (message: string) => void;
  /** Lets a subagent's launch row show its session's state and open it. */
  subagents?: SubagentRowContext;
};

export function toolResultSurfaceProps(
  card: ToolCard,
  options: Pick<ToolRenderOptions, "sessionKey" | "agentId"> & { expanded: boolean },
): ControlUiSurfaceProps["tool-result"] {
  return {
    sessionKey: options.sessionKey ?? "",
    agentId: options.agentId,
    toolName: card.name,
    toolCallId: card.callId ?? card.id,
    input: card.args,
    output: {
      text: card.outputText,
      details: card.details,
      isError: card.isError,
      completed: card.completed,
    },
    expanded: options.expanded,
  };
}
