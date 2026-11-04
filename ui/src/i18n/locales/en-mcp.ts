import type { TranslationMap } from "../lib/types.ts";
import { en } from "./en.ts";

const enMcp = {
  mcpServers: {
    signIn: "Sign in",
    signInNamed: "Sign in to {name}",
    authenticationSaved: "Signed in",
    signInFailed: "Couldn’t sign in. Check the MCP server settings and try again.",
    signInExpired: "This sign-in session ended. Close the dialog and sign in again.",
    profileSignIn: "Sign in through the linked account in Models.",
    requesterSignIn: "Each person signs in to this MCP server in Chat.",
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
    missingTransport: "Missing transport",
    addedSuccess: "Added MCP server {name}.",
    enabledSuccess: "Enabled MCP server {name}.",
    disabledSuccess: "Disabled MCP server {name}.",
    removedSuccess: "Removed MCP server {name}.",
    configUnavailable: "Couldn’t load settings. Refresh and try again.",
    connectRequired: "Reconnect to change MCP servers.",
    adminRequired: "You need admin access to change MCP servers.",
    removeNamed: "Remove {name}",
    removeConfirmTitle: "Remove {name}?",
    removeConfirmMessage:
      "This deletes the server’s saved command or URL, arguments, headers, and environment. You can’t undo this.",
    statusToolsListed: "Tools listed",
    statusFailing: "Failing",
    statusNoTools: "No tools",
    statusPending: "Not connected yet",
    pendingHint: "Connects the next time an agent uses it.",
    noToolsHint: "No tools from this server in this session. It may be failing or have none.",
    signInHint: "Connects the next time an agent uses it, once you have signed in.",
    noToolsSignInHint:
      "No tools from this server in this session. It may need sign-in, be failing, or have none.",
    tools: "Tools",
    fieldCommand: "Command",
    fieldArgs: "Arguments",
    fieldArgsHint: "One per line.",
    fieldCwd: "Working directory",
    fieldEnv: "Environment",
    fieldUrl: "URL",
    fieldHeaders: "Headers",
    fieldOauth: "OAuth sign-in",
  },
  mcpPage: {
    servers: "Servers",
    settings: "Settings",
    apps: "MCP Apps",
    noServers: "No MCP servers yet.",
    setUpFirstServer: "Add an MCP server",
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

export const registerMcpEnglish = Object.assign(
  () => {
    Object.assign(en.mcpServers, enMcp.mcpServers);
    Object.assign(en.mcpPage, enMcp.mcpPage);
  },
  { catalog: enMcp },
);
