import { resolveGatewayScopedTools } from "./tool-resolution.js";
export type McpLoopbackTool = ReturnType<typeof resolveGatewayScopedTools>["tools"][number];
export type McpToolSchemaEntry = {
    name: string;
    description: string | undefined;
    inputSchema: Record<string, unknown>;
};
export declare function buildMcpToolSchema(tools: McpLoopbackTool[]): McpToolSchemaEntry[];
