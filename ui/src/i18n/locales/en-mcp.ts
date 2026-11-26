import type { TranslationMap } from "../lib/types.ts";
import { en } from "./en.ts";

// Submission and config validation run before the optional editors load.
// Keep their errors and early MCP page labels available during locale warm-up.
export const mcpRuntimeCopy = {
  mcpServers: {
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
    settings: "Settings",
    apps: "MCP Apps",
    operatorCommands: "Command line",
  },
} satisfies TranslationMap;

export function registerMcpEnglish(): void {
  Object.assign(en.mcpServers, mcpRuntimeCopy.mcpServers);
  Object.assign(en.mcpPage, mcpRuntimeCopy.mcpPage);
}
