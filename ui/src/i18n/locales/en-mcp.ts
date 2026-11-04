import type { TranslationMap } from "../lib/types.ts";
import { en } from "./en.ts";

const enMcp = {
  mcpServers: {
    signIn: "Sign in",
    signInNamed: "Sign in {name}",
    authenticationSaved: "Authentication saved",
    signInFailed: "Sign-in did not finish. Check the MCP server settings and try again.",
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
    removeNamed: "Remove {name}",
    removeConfirmTitle: "Remove {name}?",
    removeConfirmMessage:
      "This deletes the server's saved configuration, such as its command or URL, arguments, headers, and environment. This cannot be undone.",
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
    noServers: "No MCP servers configured.",
    setUpFirstServer: "Set up your first MCP server",
    operatorCommands: "Command line",
    operatorCommandsHint: "Status, diagnostics, and runtime reload.",
    serversHelp: "About MCP servers",
    runtimeHint: "With automatic reload enabled, connections rebuild on next use.",
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
