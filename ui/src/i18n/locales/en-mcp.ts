import type { TranslationMap } from "../lib/types.ts";
import { en } from "./en.ts";

const enMcp = {
  mcpServers: {
    signIn: "Sign in",
    authenticationSaved: "Authentication saved",
    signInFailed: "Sign-in did not finish. Check the connector settings and try again.",
    signInExpired: "This sign-in session ended. Close the dialog and sign in again.",
    profileSignIn: "Sign in through the linked account in Models.",
    requesterSignIn: "Each person signs in through this connector in chat.",
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
      "The server was saved disabled globally, but enabling it for this session failed: {error}",
    sessionChanged: "The active session changed before it could be enabled.",
    sessionUnavailable: "The active session is unavailable; refresh and try again.",
    nameTaken: "An MCP server named “{name}” already exists.",
    missing: "MCP server “{name}” was not found in the configuration.",
    missingTransport: "missing transport",
    addedSuccess: "Added MCP server {name}.",
    enabledSuccess: "Enabled MCP server {name}.",
    disabledSuccess: "Disabled MCP server {name}.",
    removedSuccess: "Removed MCP server {name}.",
    configUnavailable: "Configuration is unavailable; refresh and try again.",
    connectRequired: "Connect to the gateway to change MCP servers.",
    adminRequired: "MCP server changes require operator.admin access.",
    enable: "Enable",
    disable: "Disable",
    removeNamed: "Remove {name}",
    working: "Working…",
  },
  mcpPage: {
    intro: "Connect and manage MCP servers that provide tools to OpenClaw.",
    servers: "Servers",
    oauth: "OAuth",
    filtered: "Filtered",
    configuredServers: "Configured servers",
    noServers: "No MCP servers configured.",
    setUpFirstServer: "Set up your first MCP server",
    operatorCommands: "MCP operator commands",
    operatorCommandsHint: "Status, diagnostics, auth, probing, and runtime reload.",
    runtimeHint:
      "Edits save automatically. With automatic reload enabled, MCP connections rebuild on next use.",
    toolFilter: "tool filter",
    parallel: "parallel",
    tlsVerifyOff: "TLS verify off",
    mtls: "mTLS",
  },
} satisfies TranslationMap;

export const registerMcpEnglish = Object.assign(
  () => {
    Object.assign(en.mcpServers, enMcp.mcpServers);
    Object.assign(en.mcpPage, enMcp.mcpPage);
  },
  { catalog: enMcp },
);
