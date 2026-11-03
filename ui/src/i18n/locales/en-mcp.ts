import type { TranslationMap } from "../lib/types.ts";
import { en } from "./en.ts";

const enMcp = {
  mcpServers: {
    signIn: "Sign in",
    signInNamed: "Sign in {name}",
    authenticationSaved: "Authentication saved",
    signInFailed: "Couldn’t sign in. Check the MCP server settings and try again.",
    signInExpired: "This sign-in session ended. Close the dialog and sign in again.",
    profileSignIn: "Sign in through the linked account in Models.",
    requesterSignIn: "Each person signs in through this MCP server in chat.",
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
    sessionChanged: "The active session changed before it could be enabled.",
    sessionUnavailable: "The active session is unavailable; refresh and try again.",
    nameTaken: "An MCP server named “{name}” already exists.",
    missing: "MCP server “{name}” was not found in the configuration.",
    missingTransport: "missing transport",
    addedSuccess: "Added MCP server {name}.",
    enabledSuccess: "Enabled MCP server {name}.",
    disabledSuccess: "Disabled MCP server {name}.",
    removedSuccess: "Removed MCP server {name}.",
    configUnavailable: "Couldn’t load settings. Refresh and try again.",
    connectRequired: "Reconnect to change MCP servers.",
    adminRequired: "You need admin access to change MCP servers.",
    enable: "Enable",
    enableNamed: "Enable {name}",
    disable: "Disable",
    disableNamed: "Disable {name}",
    removeNamed: "Remove {name}",
    removeConfirmTitle: "Remove {name}?",
    removeConfirmMessage:
      "This deletes the server’s saved configuration, such as its command or URL, arguments, headers, and environment. This can’t be undone.",
    working: "Working…",
    workingNamed: "Working… {name}",
  },
  mcpPage: {
    servers: "Servers",
    oauth: "OAuth",
    filtered: "Filtered",
    configuredServers: "Configured servers",
    noServers: "No MCP servers yet.",
    setUpFirstServer: "Set up your first MCP server",
    operatorCommands: "MCP admin tools",
    operatorCommandsHint: "Status, diagnostics, auth, connection checks, and runtime reload.",
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
