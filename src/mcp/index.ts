/**
 * OpenClaw Native MCP Support
 *
 * Public API for MCP (Model Context Protocol) integration.
 * Allows OpenClaw agents to connect to external MCP servers
 * and use their tools alongside native tools.
 *
 * @see DESIGN.md for architecture details
 */

// Re-export public API (filled in during later phases)
export type { McpConfig, McpServerConfig, McpTransport } from "./config.js";
