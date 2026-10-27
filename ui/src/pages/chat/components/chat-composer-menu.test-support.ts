import { vi } from "vitest";
import type { ToolsEffectiveResult } from "../../../api/types.ts";
import type { McpServerSummary } from "../../../lib/config/mcp-servers.ts";
import { createChatAttachmentInputHandle } from "./chat-attachment-inputs.ts";
import type {
  ChatComposerCapabilityMenuProps,
  ChatComposerPlusMenuProps,
} from "./chat-composer-plus-menu.types.ts";

export function makeMenu(
  overrides: Partial<ChatComposerPlusMenuProps> = {},
): ChatComposerPlusMenuProps {
  return {
    attachments: {},
    inputHandle: createChatAttachmentInputHandle(),
    disabled: false,
    open: false,
    view: "root",
    toolOverrides: null,
    onOpenChange: vi.fn(),
    onViewChange: vi.fn(),
    ...overrides,
  };
}

export function makeCapabilities(
  overrides: Partial<ChatComposerCapabilityMenuProps> = {},
): ChatComposerCapabilityMenuProps {
  return {
    basePath: "/control",
    skills: [],
    skillsRead: null,
    mcpServers: [],
    toolsEffectiveResult: null,
    toolsEffectiveLoading: false,
    toolsEffectiveError: false,
    toolAccessMutationBlockedReason: null,
    webSearchBaseEnabled: true,
    mutationBlockedReason: null,
    canAdmin: true,
    adminBlockedReason: null,
    onLoadSkills: vi.fn(),
    onPatchToolOverrides: vi.fn(),
    onNavigate: vi.fn(),
    ...overrides,
  };
}

export function docsServer(enabled: boolean): McpServerSummary {
  return {
    name: "docs",
    enabled,
    transport: "stdio",
    target: "docs-server",
    auth: null,
    signIn: null,
    toolFilter: false,
    parallel: false,
    tls: null,
  };
}

export function docsTools(includeList = false): ToolsEffectiveResult {
  const tool = (name: string, label: string, description: string) => ({
    id: `docs_${name}`,
    label,
    description,
    rawDescription: description,
    source: "mcp" as const,
    mcpServer: "docs",
    mcpToolName: name,
  });
  return {
    agentId: "main",
    profile: "full",
    groups: [
      {
        id: "mcp",
        label: "MCP",
        source: "mcp",
        tools: [
          tool("search", "Search documents", "Search"),
          ...(includeList ? [tool("list", "list", "List")] : []),
        ],
      },
    ],
  };
}
