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
      "Couldn’t enable this server for the session. It was saved disabled globally: {error}",
    sessionChanged: "Couldn’t enable this server. The active session changed. Try again.",
    sessionUnavailable: "Couldn’t open the active session. Refresh and try again.",
    nameTaken: "An MCP server named “{name}” already exists.",
    missing: "Couldn’t find MCP server “{name}” in the configuration. Refresh and try again.",
    missingTransport: "Missing transport",
    addedSuccess: "Added MCP server {name}.",
    enabledSuccess: "Enabled MCP server {name}.",
    disabledSuccess: "Disabled MCP server {name}.",
    removedSuccess: "Removed MCP server {name}.",
    configUnavailable: "Couldn’t load the configuration. Refresh and try again.",
    connectRequired: "Reconnect to change MCP servers.",
    adminRequired: "You need admin access to change MCP servers.",
    enable: "Enable",
    enableNamed: "Enable {name}",
    disable: "Disable",
    disableNamed: "Disable {name}",
    removeNamed: "Remove {name}",
    removeConfirmTitle: "Remove {name}?",
    removeConfirmMessage:
      "This deletes the server’s saved command or URL, arguments, headers, and environment. You can’t undo this.",
    working: "Working…",
    workingNamed: "Working… {name}",
  },
  mcpPage: {
    servers: "Servers",
    oauth: "OAuth",
    filtered: "Filtered",
    configuredServers: "Configured servers",
    noServers: "No MCP servers yet.",
    setUpFirstServer: "Add an MCP server",
    operatorCommands: "Advanced MCP controls",
    operatorCommandsHint: "Status, diagnostics, sign-in, connection checks, and runtime reload.",
    runtimeHint:
      "Edits save automatically. With automatic reload enabled, MCP connections rebuild on next use.",
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
