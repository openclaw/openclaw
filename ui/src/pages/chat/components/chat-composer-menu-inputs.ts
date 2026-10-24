import type { ToolsEffectiveEntry, ToolsEffectiveResult } from "../../../api/types.ts";
import { i18nRevision } from "../../../lib/reactive/i18n.ts";
import {
  countSessionToolOverrides,
  readOwnEntry,
  resolveToolOverrideState,
} from "../../../lib/sessions/tool-overrides.ts";
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
        Object.keys(menu.toolOverrides?.skills ?? {}).length > 0
          ? (menu.skills?.filter((skill) => skill.enabled).length ?? 0)
          : null,
        menu.mcpServers.filter((server) =>
          resolveToolOverrideState(
            server.enabled,
            readOwnEntry(menu.toolOverrides?.mcpServers, server.name),
          ),
        ).length,
      );
    }
  } else if (view === "skills") {
    inputs.push(menu.basePath, menu.skillsRead, menu.mutationBlockedReason);
    for (const skill of menu.skills ?? []) {
      inputs.push(skill.key, skill.name, skill.enabled, skill.missingDeps, skill.blocked);
    }
  } else if (view === "connectors") {
    inputs.push(
      menu.mutationBlockedReason,
      Boolean(menu.onOpenToolAccess),
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
  } else if (view.startsWith("tools:")) {
    const serverName = view.slice("tools:".length);
    inputs.push(
      menu.toolsEffectiveLoading,
      menu.toolsEffectiveError,
      menu.toolAccessMutationBlockedReason,
    );
    const tools = toolsForServer(menu.toolsEffectiveResult, serverName);
    for (const tool of tools) {
      inputs.push(tool.mcpToolName, tool.label, isToolDenied(menu, tool));
    }
    if (!tools.length) {
      const notice = menu.toolsEffectiveResult?.notices?.find(
        (entry) => MCP_DISCOVERY_NOTICE_IDS.has(entry.id) && entry.servers?.includes(serverName),
      );
      inputs.push(notice?.message);
    }
  }
  if (view === "skills" || view.startsWith("library:")) {
    const library = menu.library;
    inputs.push(
      Boolean(library),
      library?.loading,
      library?.busy,
      library?.error,
      library?.notice,
      library?.canWrite,
      Boolean(library?.result),
      library?.result?.defaultTarget,
      library?.result?.defaultSelectionLimit,
      library?.result?.defaultSelectionNotice,
      Boolean(library?.result?.session),
      library?.result?.session?.selections.length ?? 0,
      library?.result?.session?.attachable.length ?? 0,
    );
    for (const pin of library?.result?.session?.selections ?? []) {
      inputs.push(pin.skillId, pin.slug, pin.ownerLabel, pin.revision);
    }
    for (const pin of library?.result?.session?.attachable ?? []) {
      inputs.push(pin.skillId, pin.slug, pin.ownerLabel, pin.description);
    }
  }
  return inputs;
}
