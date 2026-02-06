import { Type } from "@sinclair/typebox";
import type { AnyAgentTool } from "./common.js";
import { renderTable, type RenderTableOptions, type TableColumn } from "../../terminal/table.js";

const FormatTableSchema = Type.Object({
  columns: Type.Array(
    Type.Object({
      key: Type.String({ description: "Property name to extract from each row object." }),
      header: Type.String({ description: "Column header text to display." }),
      align: Type.Optional(
        Type.String({ description: "Text alignment: left, right, or center. Defaults to left." }),
      ),
      minWidth: Type.Optional(Type.Number({ description: "Minimum column width in characters." })),
      maxWidth: Type.Optional(Type.Number({ description: "Maximum column width in characters." })),
    }),
    { description: "Column definitions for the table." },
  ),
  rows: Type.Array(Type.Record(Type.String(), Type.String()), {
    description: "Array of row objects with keys matching column definitions.",
  }),
  border: Type.Optional(
    Type.String({
      description: "Border style: unicode (default), ascii, or none.",
    }),
  ),
  width: Type.Optional(
    Type.Number({ description: "Maximum table width. Columns will wrap if needed." }),
  ),
});

type FormatTableParams = {
  columns: Array<{
    key: string;
    header: string;
    align?: string;
    minWidth?: number;
    maxWidth?: number;
  }>;
  rows: Array<Record<string, string>>;
  border?: string;
  width?: number;
};

/**
 * Create a tool for formatting tabular data.
 *
 * This tool allows the AI to format data as proper ASCII/Unicode tables
 * instead of relying on manual formatting that can be error-prone.
 */
export function createFormatTableTool(): AnyAgentTool {
  return {
    label: "Format Table",
    name: "format_table",
    description:
      "Format tabular data as a properly aligned ASCII or Unicode table. Use this when you need to display structured data in a clean, readable table format.",
    parameters: FormatTableSchema,
    execute: async (_toolCallId, args) => {
      const params = args as FormatTableParams;

      if (!params.columns || !Array.isArray(params.columns) || params.columns.length === 0) {
        throw new Error("At least one column is required.");
      }
      if (!params.rows || !Array.isArray(params.rows)) {
        throw new Error("Rows array is required.");
      }

      const columns: TableColumn[] = params.columns.map((col) => ({
        key: col.key,
        header: col.header,
        align: (col.align as "left" | "right" | "center") ?? "left",
        minWidth: col.minWidth,
        maxWidth: col.maxWidth,
      }));

      const borderStyle = params.border?.toLowerCase();
      const border: RenderTableOptions["border"] =
        borderStyle === "ascii" ? "ascii" : borderStyle === "none" ? "none" : "unicode";

      const options: RenderTableOptions = {
        columns,
        rows: params.rows,
        border,
        width: params.width,
      };

      const table = renderTable(options);

      return {
        content: [
          {
            type: "text" as const,
            text: table,
          },
        ],
        details: { table },
      };
    },
  };
}
