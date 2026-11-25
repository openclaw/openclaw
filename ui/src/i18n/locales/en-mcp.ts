import type { TranslationMap } from "../lib/types.ts";
import { en } from "./en.ts";

// Keep the composer form and runtime errors available without the Settings
// catalog. Register the MCP page namespace here to preserve locale warm-up.
export const mcpRuntimeCopy = {
  mcpServers: {
    add: "Add server",
    adding: "Adding…",
    nameLabel: "Name",
    transportLabel: "Transport",
    transportStreamableHttp: "Streamable HTTP",
    transportSse: "SSE",
    transportStdio: "Stdio",
    targetLabel: "URL or command",
    nameInvalid: "Server names use letters, numbers, dots, dashes, or underscores.",
    targetInvalid: "Enter a URL for HTTP transports or a valid command line for stdio.",
    sessionEnableFailed:
      "The server was saved but is still disabled. Couldn’t enable it for this session. {error}",
    sessionChanged: "Couldn’t enable this server. The active session changed. Try again.",
    sessionUnavailable: "Couldn’t open the active session. Refresh and try again.",
    nameTaken: "An MCP server named “{name}” already exists.",
    missing: "Couldn’t find MCP server “{name}” in the configuration. Refresh and try again.",
    configUnavailable: "Couldn’t load settings. Refresh and try again.",
  },
  mcpPage: {
    servers: "Servers",
    settings: "Settings",
    apps: "MCP Apps",
    noServers: "No MCP servers yet.",
    setUpFirstServer: "MCP server setup guide",
    operatorCommands: "Command line",
    operatorCommandsHint: "Status, diagnostics, and runtime reload.",
    serversHelp: "About MCP servers",
    runtimeHint: "With automatic reload enabled, connections rebuild on next use.",
    toolFilter: "Tool filter",
    parallel: "Parallel",
    tlsVerifyOff: "TLS verification off",
    mtls: "mTLS",
  },
} satisfies TranslationMap;

export function registerMcpEnglish(): void {
  Object.assign(en.mcpServers, mcpRuntimeCopy.mcpServers);
  Object.assign(en.mcpPage, mcpRuntimeCopy.mcpPage);
}
