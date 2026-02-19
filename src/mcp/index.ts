/**
 * OpenClaw Native MCP Support
 *
 * Public API for MCP (Model Context Protocol) integration.
 * Allows OpenClaw agents to connect to external MCP servers
 * and use their tools alongside native tools.
 *
 * @see DESIGN.md for architecture details
 */

// Config
export type { McpConfig, McpServerConfig, McpTransport } from "./config.js";
export { validateMcpConfig } from "./config.js";

// Manager
export { McpManager } from "./manager.js";
export type { McpManagerOptions, McpServerStatus } from "./manager.js";
