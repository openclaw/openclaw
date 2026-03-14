/**
 * Supabase Workflow Node Definitions
 * 
 * Defines the UI node types for Supabase operations in the workflow editor.
 * Each node has input/output schemas for structured data flow.
 */

/**
 * Input schema for Supabase SELECT node.
 */
const selectInputSchema = {
  type: "object",
  properties: {
    instance: {
      type: "string",
      title: "Supabase Instance",
      description: "Supabase instance configuration name",
    },
    table: {
      type: "string",
      title: "Table Name",
      description: "Database table to query",
    },
    columns: {
      type: "string",
      title: "Columns",
      description: "Columns to select (comma-separated, or * for all)",
      default: "*",
    },
    filters: {
      type: "object",
      title: "Filters",
      description: "Filter conditions (JSON format)",
      default: {},
    },
    orderBy: {
      type: "object",
      title: "Order By",
      description: "Sorting configuration",
      properties: {
        column: { type: "string", title: "Column" },
        ascending: { type: "boolean", title: "Ascending", default: true },
      },
    },
    limit: {
      type: "number",
      title: "Limit",
      description: "Maximum number of rows to return",
      minimum: 1,
      maximum: 1000,
    },
    offset: {
      type: "number",
      title: "Offset",
      description: "Number of rows to skip",
      minimum: 0,
      default: 0,
    },
  },
  required: ["table"],
} as const;

/**
 * Output schema for Supabase SELECT node.
 */
const selectOutputSchema = {
  type: "object",
  properties: {
    success: {
      type: "boolean",
      title: "Success",
    },
    data: {
      type: "array",
      title: "Data",
      description: "Query results",
      items: { type: "object" },
    },
    count: {
      type: "number",
      title: "Count",
      description: "Number of rows returned",
    },
    error: {
      type: "string",
      title: "Error",
      description: "Error message if failed",
    },
    timestamp: {
      type: "number",
      title: "Timestamp",
      description: "Operation timestamp",
    },
  },
} as const;

/**
 * Input schema for Supabase INSERT node.
 */
const insertInputSchema = {
  type: "object",
  properties: {
    instance: {
      type: "string",
      title: "Supabase Instance",
      description: "Supabase instance configuration name",
    },
    table: {
      type: "string",
      title: "Table Name",
      description: "Database table to insert into",
    },
    data: {
      type: ["object", "array"],
      title: "Data",
      description: "Row data to insert (object or array of objects)",
    },
    returning: {
      type: "string",
      title: "Returning",
      description: "Return inserted data",
      enum: ["representation", "minimal"],
      default: "representation",
    },
    upsert: {
      type: "boolean",
      title: "Upsert",
      description: "Upsert on conflict",
      default: false,
    },
    onConflict: {
      type: "string",
      title: "On Conflict",
      description: "Column to check for upsert conflict",
    },
  },
  required: ["table", "data"],
} as const;

/**
 * Output schema for Supabase INSERT node.
 */
const insertOutputSchema = {
  type: "object",
  properties: {
    success: {
      type: "boolean",
      title: "Success",
    },
    data: {
      type: ["object", "array"],
      title: "Data",
      description: "Inserted row(s)",
    },
    count: {
      type: "number",
      title: "Count",
      description: "Number of rows inserted",
    },
    error: {
      type: "string",
      title: "Error",
      description: "Error message if failed",
    },
    timestamp: {
      type: "number",
      title: "Timestamp",
      description: "Operation timestamp",
    },
  },
} as const;

/**
 * Input schema for Supabase UPDATE node.
 */
const updateInputSchema = {
  type: "object",
  properties: {
    instance: {
      type: "string",
      title: "Supabase Instance",
      description: "Supabase instance configuration name",
    },
    table: {
      type: "string",
      title: "Table Name",
      description: "Database table to update",
    },
    data: {
      type: "object",
      title: "Data",
      description: "New values to set",
    },
    filters: {
      type: "object",
      title: "Filters",
      description: "Filter conditions to match rows (JSON format)",
    },
    returning: {
      type: "string",
      title: "Returning",
      description: "Return updated data",
      enum: ["representation", "minimal"],
      default: "representation",
    },
  },
  required: ["table", "data", "filters"],
} as const;

/**
 * Output schema for Supabase UPDATE node.
 */
const updateOutputSchema = {
  type: "object",
  properties: {
    success: {
      type: "boolean",
      title: "Success",
    },
    data: {
      type: "array",
      title: "Data",
      description: "Updated rows",
      items: { type: "object" },
    },
    count: {
      type: "number",
      title: "Count",
      description: "Number of rows updated",
    },
    error: {
      type: "string",
      title: "Error",
      description: "Error message if failed",
    },
    timestamp: {
      type: "number",
      title: "Timestamp",
      description: "Operation timestamp",
    },
  },
} as const;

/**
 * Input schema for Supabase DELETE node.
 */
const deleteInputSchema = {
  type: "object",
  properties: {
    instance: {
      type: "string",
      title: "Supabase Instance",
      description: "Supabase instance configuration name",
    },
    table: {
      type: "string",
      title: "Table Name",
      description: "Database table to delete from",
    },
    filters: {
      type: "object",
      title: "Filters",
      description: "Filter conditions to match rows (JSON format)",
    },
    returning: {
      type: "string",
      title: "Returning",
      description: "Return deleted data",
      enum: ["representation", "minimal"],
      default: "representation",
    },
  },
  required: ["table", "filters"],
} as const;

/**
 * Output schema for Supabase DELETE node.
 */
const deleteOutputSchema = {
  type: "object",
  properties: {
    success: {
      type: "boolean",
      title: "Success",
    },
    data: {
      type: "array",
      title: "Data",
      description: "Deleted rows",
      items: { type: "object" },
    },
    count: {
      type: "number",
      title: "Count",
      description: "Number of rows deleted",
    },
    error: {
      type: "string",
      title: "Error",
      description: "Error message if failed",
    },
    timestamp: {
      type: "number",
      title: "Timestamp",
      description: "Operation timestamp",
    },
  },
} as const;

/**
 * Input schema for Supabase RPC node.
 */
const rpcInputSchema = {
  type: "object",
  properties: {
    instance: {
      type: "string",
      title: "Supabase Instance",
      description: "Supabase instance configuration name",
    },
    functionName: {
      type: "string",
      title: "Function Name",
      description: "Database function to call",
    },
    args: {
      type: "object",
      title: "Arguments",
      description: "Function arguments (JSON format)",
      default: {},
    },
  },
  required: ["functionName"],
} as const;

/**
 * Output schema for Supabase RPC node.
 */
const rpcOutputSchema = {
  type: "object",
  properties: {
    success: {
      type: "boolean",
      title: "Success",
    },
    data: {
      type: ["object", "array", "string", "number", "boolean"],
      title: "Data",
      description: "Function return value",
    },
    error: {
      type: "string",
      title: "Error",
      description: "Error message if failed",
    },
    timestamp: {
      type: "number",
      title: "Timestamp",
      description: "Operation timestamp",
    },
  },
} as const;

/**
 * Supabase workflow node definitions.
 */
export const SUPABASE_NODES = {
  select: {
    type: "action",
    label: "Supabase Select",
    icon: "🔍",
    actionType: "supabase-select",
    description: "Query data from a Supabase table",
    inputSchema: selectInputSchema,
    outputSchema: selectOutputSchema,
  },
  insert: {
    type: "action",
    label: "Supabase Insert",
    icon: "➕",
    actionType: "supabase-insert",
    description: "Insert new rows into a Supabase table",
    inputSchema: insertInputSchema,
    outputSchema: insertOutputSchema,
  },
  update: {
    type: "action",
    label: "Supabase Update",
    icon: "✏️",
    actionType: "supabase-update",
    description: "Update existing rows in a Supabase table",
    inputSchema: updateInputSchema,
    outputSchema: updateOutputSchema,
  },
  delete: {
    type: "action",
    label: "Supabase Delete",
    icon: "🗑️",
    actionType: "supabase-delete",
    description: "Delete rows from a Supabase table",
    inputSchema: deleteInputSchema,
    outputSchema: deleteOutputSchema,
  },
  rpc: {
    type: "action",
    label: "Supabase RPC",
    icon: "⚡",
    actionType: "supabase-rpc",
    description: "Call a Supabase database function",
    inputSchema: rpcInputSchema,
    outputSchema: rpcOutputSchema,
  },
} as const;

/**
 * Get all Supabase node types.
 */
export function getSupabaseNodeTypes(): string[] {
  return Object.values(SUPABASE_NODES).map((node) => node.actionType);
}

/**
 * Get a specific Supabase node definition.
 */
export function getSupabaseNode(actionType: string): (typeof SUPABASE_NODES)[keyof typeof SUPABASE_NODES] | undefined {
  return Object.values(SUPABASE_NODES).find((node) => node.actionType === actionType);
}

/**
 * Export types.
 */
export type SupabaseNodeType = keyof typeof SUPABASE_NODES;
export type SupabaseActionType = (typeof SUPABASE_NODES)[keyof typeof SUPABASE_NODES]["actionType"];
