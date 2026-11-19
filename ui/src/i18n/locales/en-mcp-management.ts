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
    add: mcpRuntimeCopy.mcpServers.add,
    adding: mcpRuntimeCopy.mcpServers.adding,
    nameLabel: mcpRuntimeCopy.mcpServers.nameLabel,
    transportLabel: mcpRuntimeCopy.mcpServers.transportLabel,
    transportStreamableHttp: mcpRuntimeCopy.mcpServers.transportStreamableHttp,
    transportSse: mcpRuntimeCopy.mcpServers.transportSse,
    transportStdio: mcpRuntimeCopy.mcpServers.transportStdio,
    targetLabel: mcpRuntimeCopy.mcpServers.targetLabel,
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
  mcpPage: mcpRuntimeCopy.mcpPage,
} satisfies TranslationMap;

export const registerMcpManagementEnglish = Object.assign(
  () => {
    Object.assign(en.mcpServers, enMcp.mcpServers);
    Object.assign(en.mcpPage, enMcp.mcpPage);
  },
  { catalog: enMcp },
);
