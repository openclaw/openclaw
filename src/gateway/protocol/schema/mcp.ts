/**
 * TypeBox schemas for MCP Apps gateway WebSocket methods.
 *
 * Methods:
 *   mcp.tools.list      — list tools with _meta.ui (MCP App-enabled tools)
 *   mcp.tools.call      — execute a tool by name
 *   mcp.resources.list  — list registered ui:// resources
 *   mcp.resources.read  — fetch HTML content for a ui:// resource
 *
 * Schema shapes follow the MCP Apps spec (SEP-1865):
 *   - Tool _meta.ui: resourceUri + visibility only
 *   - Resource content _meta.ui: csp (domain-based) + permissions (structured) + domain + prefersBorder
 */
import { type Static, Type } from "@sinclair/typebox";
import { NonEmptyString } from "./primitives.js";

// ---------------------------------------------------------------------------
// Shared sub-schemas: Tool _meta.ui (SEP-1865 § Resource Discovery)
// ---------------------------------------------------------------------------

export const McpToolUiMetaSchema = Type.Object(
  {
    resourceUri: NonEmptyString,
    visibility: Type.Optional(Type.Array(Type.Union([Type.Literal("model"), Type.Literal("app")]))),
  },
  { additionalProperties: false },
);

export const McpToolMetaSchema = Type.Object(
  {
    ui: Type.Optional(McpToolUiMetaSchema),
  },
  { additionalProperties: false },
);

export const McpToolEntrySchema = Type.Object(
  {
    name: NonEmptyString,
    description: Type.Optional(Type.String()),
    inputSchema: Type.Record(Type.String(), Type.Unknown()),
    _meta: Type.Optional(McpToolMetaSchema),
  },
  { additionalProperties: true },
);

// ---------------------------------------------------------------------------
// Shared sub-schemas: Resource _meta.ui (SEP-1865 § UI Resource Format)
// ---------------------------------------------------------------------------

export const McpUiResourceCspSchema = Type.Object(
  {
    connectDomains: Type.Optional(Type.Array(Type.String())),
    resourceDomains: Type.Optional(Type.Array(Type.String())),
    frameDomains: Type.Optional(Type.Array(Type.String())),
    baseUriDomains: Type.Optional(Type.Array(Type.String())),
  },
  { additionalProperties: false },
);

export const McpUiPermissionsSchema = Type.Object(
  {
    camera: Type.Optional(Type.Object({})),
    microphone: Type.Optional(Type.Object({})),
    geolocation: Type.Optional(Type.Object({})),
    clipboardWrite: Type.Optional(Type.Object({})),
  },
  { additionalProperties: false },
);

export const McpResourceUiMetaSchema = Type.Object(
  {
    csp: Type.Optional(McpUiResourceCspSchema),
    permissions: Type.Optional(McpUiPermissionsSchema),
    domain: Type.Optional(Type.String()),
    prefersBorder: Type.Optional(Type.Boolean()),
  },
  { additionalProperties: false },
);

export const McpResourceMetaSchema = Type.Object(
  {
    ui: Type.Optional(McpResourceUiMetaSchema),
  },
  { additionalProperties: false },
);

export const McpResourceEntrySchema = Type.Object(
  {
    uri: NonEmptyString,
    name: NonEmptyString,
    mimeType: NonEmptyString,
  },
  { additionalProperties: false },
);

export const McpContentBlockSchema = Type.Object(
  {
    uri: NonEmptyString,
    mimeType: NonEmptyString,
    text: Type.String(),
    _meta: Type.Optional(McpResourceMetaSchema),
  },
  { additionalProperties: false },
);

// ---------------------------------------------------------------------------
// mcp.tools.list
// ---------------------------------------------------------------------------

/**
 * Caller role for MCP Apps visibility filtering.
 *
 * - `"model"` — the LLM agent; tools with `visibility: ["app"]` are excluded.
 * - `"app"`   — the MCP App iframe; tools with `visibility: ["model"]` are excluded.
 * - omitted  — no filtering, all tools returned (backward-compatible default).
 */
export const McpCallerRoleSchema = Type.Union([Type.Literal("model"), Type.Literal("app")]);

export const McpToolsListParamsSchema = Type.Object(
  {
    sessionKey: Type.Optional(Type.String()),
    callerRole: Type.Optional(McpCallerRoleSchema),
  },
  { additionalProperties: false },
);

export const McpToolsListResultSchema = Type.Object(
  {
    tools: Type.Array(McpToolEntrySchema),
  },
  { additionalProperties: false },
);

// ---------------------------------------------------------------------------
// mcp.tools.call
// ---------------------------------------------------------------------------

export const McpToolsCallParamsSchema = Type.Object(
  {
    name: NonEmptyString,
    arguments: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
    sessionKey: Type.Optional(Type.String()),
    callerRole: Type.Optional(McpCallerRoleSchema),
  },
  { additionalProperties: false },
);

export const McpToolsCallResultSchema = Type.Object(
  {
    content: Type.Array(
      Type.Object(
        {
          type: Type.String(),
          text: Type.Optional(Type.String()),
          data: Type.Optional(Type.String()),
          mimeType: Type.Optional(Type.String()),
        },
        { additionalProperties: true },
      ),
    ),
    isError: Type.Boolean(),
    _meta: Type.Optional(McpToolMetaSchema),
  },
  { additionalProperties: false },
);

// ---------------------------------------------------------------------------
// mcp.resources.list
// ---------------------------------------------------------------------------

export const McpResourcesListParamsSchema = Type.Object(
  {
    /**
     * Reserved for future session-scoped resource isolation.
     * Currently accepted and validated but not used — resources remain
     * process-global. Accepted now so clients can send it without breaking
     * when per-session scoping is added.
     */
    sessionKey: Type.Optional(
      Type.String({
        description:
          "Reserved for future session-scoped resource isolation. Currently accepted but not used — resources are process-global.",
      }),
    ),
  },
  { additionalProperties: false },
);

export const McpResourcesListResultSchema = Type.Object(
  {
    resources: Type.Array(McpResourceEntrySchema),
  },
  { additionalProperties: false },
);

// ---------------------------------------------------------------------------
// mcp.resources.read
// ---------------------------------------------------------------------------

export const McpResourcesReadParamsSchema = Type.Object(
  {
    uri: NonEmptyString,
    /**
     * Reserved for future session-scoped resource isolation.
     * Currently accepted and validated but not used — resources remain
     * process-global. Accepted now so clients can send it without breaking
     * when per-session scoping is added.
     */
    sessionKey: Type.Optional(
      Type.String({
        description:
          "Reserved for future session-scoped resource isolation. Currently accepted but not used — resources are process-global.",
      }),
    ),
  },
  { additionalProperties: false },
);

export const McpResourcesReadResultSchema = Type.Object(
  {
    contents: Type.Array(McpContentBlockSchema),
  },
  { additionalProperties: false },
);

// ---------------------------------------------------------------------------
// Inferred types
// ---------------------------------------------------------------------------

export type McpToolsListParams = Static<typeof McpToolsListParamsSchema>;
export type McpToolsListResult = Static<typeof McpToolsListResultSchema>;
export type McpToolsCallParams = Static<typeof McpToolsCallParamsSchema>;
export type McpToolsCallResult = Static<typeof McpToolsCallResultSchema>;
export type McpResourcesListParams = Static<typeof McpResourcesListParamsSchema>;
export type McpResourcesListResult = Static<typeof McpResourcesListResultSchema>;
export type McpResourcesReadParams = Static<typeof McpResourcesReadParamsSchema>;
export type McpResourcesReadResult = Static<typeof McpResourcesReadResultSchema>;
