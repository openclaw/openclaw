import type { ToolsEffectiveEntry, ToolsEffectiveResult } from "../../../api/types.ts";
import { formatUiExternalText } from "../../../lib/format-error.ts";
import { i18nRevision } from "../../../lib/reactive/i18n.ts";
import { countSessionToolOverrides, readOwnEntry } from "../../../lib/sessions/tool-overrides.ts";
import { uploadsEnabled } from "../../../lib/uploads.ts";
import type {
  ChatComposerPlusMenuContentProps,
  ChatComposerPlusMenuView,
} from "./chat-composer-plus-menu.types.ts";

type McpToolEntry = ToolsEffectiveEntry & { mcpServer: string; mcpToolName: string };
export const toolsForServer = (
  result: ToolsEffectiveResult | null,
  serverName: string,
): McpToolEntry[] =>
  (result?.groups ?? [])
    .flatMap((group) => group.tools)
    .filter(
      (tool): tool is McpToolEntry =>
        tool.source === "mcp" && tool.mcpServer === serverName && Boolean(tool.mcpToolName),
    );
export const MCP_DISCOVERY_NOTICE_IDS = new Set([
  "mcp-not-yet-connected",
  "mcp-not-yet-listed",
  "mcp-stale-catalog",
]);
export function mcpDiscoveryNotice(
  result: ToolsEffectiveResult | null,
  serverName: string,
): string | undefined {
  const notice = result?.notices?.find(
    (entry) => MCP_DISCOVERY_NOTICE_IDS.has(entry.id) && entry.servers?.includes(serverName),
  );
  return notice ? formatUiExternalText(notice.message) || undefined : undefined;
}

export function labelsForMcpTools(tools: readonly McpToolEntry[]): ReadonlyMap<string, string> {
  const labels = new Map<string, string>(
    tools.map((tool) => [tool.mcpToolName, tool.label?.trim() || tool.mcpToolName]),
  );
  let changed: boolean;
  do {
    changed = false;
    const counts = new Map<string, number>();
    for (const label of labels.values()) {
      counts.set(label, (counts.get(label) ?? 0) + 1);
    }
    // A raw fallback can collide with another friendly label, so resolve that chain too.
    for (const [name, label] of labels) {
      if (label !== name && (counts.get(label) ?? 0) > 1) {
        labels.set(name, name);
        changed = true;
      }
    }
  } while (changed);
  return labels;
}

export const isToolDenied = (
  props: ChatComposerPlusMenuContentProps,
  tool: McpToolEntry,
): boolean =>
  props.toolOverrides != null
    ? (readOwnEntry(props.toolOverrides.mcpToolsDeny, tool.mcpServer)?.includes(tool.mcpToolName) ??
      false)
    : tool.deniedBySession === true;

/** Snapshot rendered values, not mutable DTO identities or action callbacks. */
export function menuRenderInputs(
  menu: ChatComposerPlusMenuContentProps,
  view: ChatComposerPlusMenuView,
) {
  const inputs: unknown[] = [i18nRevision()];
  if (view === "root") {
    inputs.push(uploadsEnabled(menu.attachments.uploadConfig), menu.showCapabilities);
    for (const toggle of menu.rootToggles ?? []) {
      inputs.push(
        toggle.value,
        toggle.label,
        toggle.icon,
        toggle.checked,
        toggle.disabled,
        toggle.title,
      );
    }
    if (menu.showCapabilities) {
      inputs.push(
        menu.basePath,
        menu.mutationBlockedReason,
        menu.webSearchBaseEnabled,
        menu.toolOverrides?.webSearch,
        countSessionToolOverrides(menu.toolOverrides),
      );
    }
  } else if (view === "skills") {
    inputs.push(menu.basePath, menu.skillsRead, menu.mutationBlockedReason);
    for (const skill of menu.skills ?? []) {
      inputs.push(
        skill.key,
        skill.name,
        skill.emoji,
        skill.enabled,
        skill.missingDeps,
        skill.blocked,
      );
    }
  } else if (view === "connectors") {
    inputs.push(
      menu.mutationBlockedReason,
      Boolean(menu.onOpenToolAccess),
      menu.basePath,
      Boolean(menu.onAddServer),
      menu.canAdmin,
      menu.adminBlockedReason,
    );
    for (const server of menu.mcpServers) {
      inputs.push(
        server.name,
        server.enabled,
        readOwnEntry(menu.toolOverrides?.mcpServers, server.name),
      );
    }
  }
  if (view === "connectors") {
    inputs.push(
      menu.toolsEffectiveLoading,
      menu.toolsEffectiveError,
      menu.toolAccessMutationBlockedReason,
    );
    const tools = menu.mcpServers.flatMap((server) =>
      toolsForServer(menu.toolsEffectiveResult, server.name),
    );
    for (const tool of tools) {
      inputs.push(tool.mcpServer, tool.mcpToolName, tool.label, isToolDenied(menu, tool));
    }
    for (const notice of menu.toolsEffectiveResult?.notices ?? []) {
      inputs.push(notice.id, notice.message, ...(notice.servers ?? []));
    }
  }

  if (view === "skills" || view === "libraries" || view.startsWith("library:")) {
    const library = menu.library;
    inputs.push(
      Boolean(library),
      library?.loading,
      library?.busy,
      library?.error,
      library?.canWrite,
      Boolean(library?.result),
      Boolean(library?.result?.session),
      library?.result?.session?.selections.length ?? 0,
      library?.result?.session?.attachable.length ?? 0,
    );
    for (const pin of library?.result?.session?.selections ?? []) {
      inputs.push(pin.skillId, pin.slug, pin.ownerLabel, pin.description, pin.revision);
    }
    for (const entry of library?.result?.entries ?? []) {
      inputs.push(entry.skillId, entry.name, entry.revision, entry.description, entry.ownerLabel);
    }
    for (const pin of library?.result?.session?.attachable ?? []) {
      inputs.push(pin.skillId, pin.slug, pin.name, pin.ownerLabel, pin.description, pin.revision);
    }
  }
  return inputs;
}
