import type { TranslationMap } from "../lib/types.ts";
import { mcpRuntimeCopy } from "./en-mcp.ts";
import { en } from "./en.ts";

// Preserve canonical translation-memory order across the boot and lazy catalogs.
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
    nameInvalid: mcpRuntimeCopy.mcpServers.nameInvalid,
    targetInvalid: mcpRuntimeCopy.mcpServers.targetInvalid,
    sessionEnableFailed: mcpRuntimeCopy.mcpServers.sessionEnableFailed,
    sessionChanged: mcpRuntimeCopy.mcpServers.sessionChanged,
    sessionUnavailable: mcpRuntimeCopy.mcpServers.sessionUnavailable,
    nameTaken: mcpRuntimeCopy.mcpServers.nameTaken,
    missing: mcpRuntimeCopy.mcpServers.missing,
    missingTransport: "Missing transport",
    addedSuccess: "Added MCP server {name}.",
    enabledSuccess: "Enabled MCP server {name}.",
    disabledSuccess: "Disabled MCP server {name}.",
    removedSuccess: "Removed MCP server {name}.",
    configUnavailable: mcpRuntimeCopy.mcpServers.configUnavailable,
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
    settings: mcpRuntimeCopy.mcpPage.settings,
    apps: mcpRuntimeCopy.mcpPage.apps,
    noServers: "No MCP servers yet.",
    setUpFirstServer: "MCP server setup guide",
    operatorCommands: mcpRuntimeCopy.mcpPage.operatorCommands,
    operatorCommandsHint: "Status, diagnostics, and runtime reload.",
    serversHelp: "About MCP servers",
    runtimeHint: "With automatic reload enabled, connections rebuild on next use.",
    toolFilter: "Tool filter",
    parallel: "Parallel",
    tlsVerifyOff: "TLS verification off",
    mtls: "mTLS",
  },
} satisfies TranslationMap;

export const registerMcpManagementEnglish = Object.assign(
  () => {
    Object.assign(en.mcpServers, enMcp.mcpServers);
    Object.assign(en.mcpPage, enMcp.mcpPage);
  },
  { catalog: enMcp },
);
