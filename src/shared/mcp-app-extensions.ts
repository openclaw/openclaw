/** Wire metadata for OpenAI MCP Plugin Extensions; never a tool grant. */
export type McpAppIcon = {
  src: string;
  mimeType?: string;
  sizes?: string[];
  theme?: "light" | "dark";
};
type McpAppQuickAction = {
  title: string;
  icons: McpAppIcon[];
  target: { type: "tool"; name: string; arguments?: Record<string, unknown> };
};
type McpAppEntrypoint =
  | { type: "global"; quickAction?: McpAppQuickAction }
  | { type: "thread" }
  | { type: "file"; extensions: string[] }
  | { type: "settings"; searchTerms?: string[] };
export type McpAppToolExtensions = {
  entrypoints?: McpAppEntrypoint[];
  mentionSearch?: true;
  icons?: McpAppIcon[];
  preferredModelDisplayMode?: "inline" | "fullscreen";
};
export type McpAppSettingsCapability = { readTool: string; updateTool: string };
type McpAppSettingSchema = { title: string; description?: string } & (
  | { type: "boolean" }
  | { type: "string"; enum?: string[]; minLength?: number; maxLength?: number; pattern?: string }
  | { type: "number" | "integer"; minimum?: number; maximum?: number; multipleOf?: number }
);
type McpAppSettingsGroup = {
  kind: "group";
  title: string;
  items: Array<
    | { kind: "property"; property: string }
    | { kind: "tool"; tool: string; title: string; description?: string }
  >;
};
export type McpAppSettings = {
  schema: { type: "object"; properties: Record<string, McpAppSettingSchema>; required?: string[] };
  values: Record<string, string | number | boolean>;
  layout?: McpAppSettingsGroup[];
};
export type McpAppDiscoveredEntrypoint = {
  toolName: string;
  title: string;
  resourceUri: string;
  icons?: McpAppIcon[];
  entrypoint: McpAppEntrypoint;
};
export type McpAppDiscoveredServer = {
  serverName: string;
  /** Verified plugin attribution, absent for unowned configured servers. */
  pluginId?: string;
  marketplace?: string;
  label: string;
  icons?: McpAppIcon[];
  entrypoints: McpAppDiscoveredEntrypoint[];
  settings?: McpAppSettingsCapability;
  mentionTool?: string;
};
export type McpAppDiscoverResult = {
  servers: McpAppDiscoveredServer[];
  onboarding?: Array<{ pluginId: string; title: string }>;
};
export type McpAppExtensionTarget = { sessionKey: string; agentId?: string };
export type McpAppSettingsParams = McpAppExtensionTarget & {
  serverName: string;
  action: "read" | "update" | "tool";
  arguments?: { set: Record<string, string | number | boolean> };
  toolName?: string;
};
export type McpAppResourceLink = {
  type: "resource_link";
  uri: string;
  name: string;
  title?: string;
  description?: string;
  mimeType?: string;
};
export type McpAppMentionResult = { resources: McpAppResourceLink[] };
