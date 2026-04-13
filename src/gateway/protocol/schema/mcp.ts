/**
 * TypeBox schemas for MCP Apps gateway WebSocket methods.
 *
 * Methods:
 *   mcp.tools.list      — list tools with _meta.ui (MCP App-enabled tools)
 *   mcp.tools.call      — execute a tool by name
 *   mcp.resources.list  — list registered ui:// resources
 *   mcp.resources.read  — fetch HTML content for a ui:// resource
 */
import { type Static, Type } from "@sinclair/typebox";
import { NonEmptyString } from "./primitives.js";

// ---------------------------------------------------------------------------
// Shared sub-schemas
// ---------------------------------------------------------------------------

export const McpToolUiMetaSchema = Type.Object(
  {
    resourceUri: NonEmptyString,
    permissions: Type.Optional(Type.Array(Type.String())),
    csp: Type.Optional(Type.Record(Type.String(), Type.Array(Type.String()))),
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
  },
  { additionalProperties: false },
);

// ---------------------------------------------------------------------------
// mcp.tools.list
// ---------------------------------------------------------------------------

export const McpToolsListParamsSchema = Type.Object(
  {
    sessionKey: Type.Optional(Type.String()),
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
    sessionKey: Type.Optional(Type.String()),
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
