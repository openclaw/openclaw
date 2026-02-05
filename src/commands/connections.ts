/**
 * CLI commands for managing connection providers.
 *
 * Commands:
 *   clawdbrain connections login <provider>   - Connect to a provider via OAuth
 *   clawdbrain connections status [provider]  - Show connection status
 *   clawdbrain connections logout <provider>  - Disconnect a provider
 *   clawdbrain connections list               - List available providers
 */

import type { RuntimeEnv } from "../runtime.js";
import type { WizardPrompter } from "../wizard/prompts.js";
import {
  getAllConnectionProviders,
  getConnectionProvider,
  getConnectionProviderIds,
  getAllConnectionStatuses,
  getConnectionStatus,
  removeConnectionCredential,
  getDefaultScopes,
  getScopesForPreset,
  getPresetsForProvider,
} from "../providers/connections/index.js";
import {
  startOAuthFlow,
  completeOAuthFlow,
  waitForLocalCallback,
  parseOAuthCallbackInput,
  getClientCredentials,
} from "../providers/connections/oauth-flow.js";
import { renderTable } from "../terminal/table.js";
import { theme } from "../terminal/theme.js";
import { isRemoteEnvironment } from "./oauth-env.js";
import { openUrl } from "./onboard-helpers.js";

const DEFAULT_REDIRECT_PORT = 18790;

interface ConnectionsCommandParams {
  prompter: WizardPrompter;
  runtime: RuntimeEnv;
  agentDir?: string;
}

/**
 * Handle `clawdbrain connections login <provider>` command.
 */
export async function connectionsLogin(
  params: ConnectionsCommandParams & {
    providerId: string;
    scopes?: string[];
    preset?: string;
  },
): Promise<boolean> {
  const { prompter, runtime, agentDir, providerId, scopes, preset } = params;

  const provider = getConnectionProvider(providerId);
  if (!provider) {
    const available = getConnectionProviderIds().join(", ");
    runtime.error(`Unknown provider: ${providerId}`);
    runtime.log(`Available providers: ${available}`);
    return false;
  }

  // Check for existing connection
  const existingStatus = getConnectionStatus(providerId, agentDir);
  if (existingStatus?.connected) {
    const reconnect = await prompter.confirm({
      message: `${provider.label} is already connected. Re-authorize with new permissions?`,
    });
    if (!reconnect) {
      return false;
    }
  }

  // Get client credentials
  let clientId: string;
  let clientSecret: string | undefined;

  try {
    const creds = getClientCredentials(providerId);
    clientId = creds.clientId;
    clientSecret = creds.clientSecret;
  } catch (err) {
    runtime.error(err instanceof Error ? err.message : String(err));
    await showOAuthSetupHelp(prompter, provider);
    return false;
  }

  // Determine scopes to request
  let requestedScopes: string[];
  if (scopes && scopes.length > 0) {
    requestedScopes = scopes;
  } else if (preset) {
    const presetScopes = getScopesForPreset(providerId, preset);
    if (!presetScopes) {
      const available = getPresetsForProvider(providerId)
        .map((p) => p.id)
        .join(", ");
      runtime.error(`Unknown preset: ${preset}`);
      runtime.log(`Available presets: ${available}`);
      return false;
    }
    requestedScopes = presetScopes;
  } else {
    // Use interactive scope selection or defaults
    requestedScopes = await selectScopes(prompter, provider);
  }

  // Build redirect URI
  const isRemote = isRemoteEnvironment();
  const redirectUri = `http://127.0.0.1:${DEFAULT_REDIRECT_PORT}${provider.oauth.defaultRedirectPath ?? "/oauth/callback"}`;

  // Start OAuth flow
  const flowResult = startOAuthFlow({
    providerId,
    clientId,
    redirectUri,
    scopes: requestedScopes,
    agentDir,
  });

  if ("error" in flowResult) {
    runtime.error(flowResult.error);
    return false;
  }

  const { authorizeUrl, flowState } = flowResult;

  // Show instructions based on environment
  if (isRemote) {
    await prompter.note(
      [
        "You are running in a remote/VPS environment.",
        "Open this URL in your LOCAL browser:",
        "",
        authorizeUrl,
        "",
        "After authorization, paste the redirect URL back here.",
      ].join("\n"),
      `${provider.label} OAuth`,
    );
  } else {
    await prompter.note(
      [
        `Opening browser for ${provider.label} authorization...`,
        "",
        "If the browser doesn't open, visit:",
        authorizeUrl,
      ].join("\n"),
      `${provider.label} OAuth`,
    );
  }

  const spin = prompter.progress("Starting OAuth flow...");

  let code: string;
  let receivedState: string;

  if (isRemote) {
    // Manual flow for remote environments
    spin.stop("Waiting for authorization...");

    const input = await prompter.text({
      message: "Paste the redirect URL (or authorization code)",
      placeholder: `${redirectUri}?code=...&state=...`,
      validate: (value) => (value?.trim() ? undefined : "Required"),
    });

    const parsed = parseOAuthCallbackInput(String(input), flowState.state);
    if ("error" in parsed) {
      runtime.error(parsed.error);
      return false;
    }

    code = parsed.code;
    receivedState = parsed.state;
  } else {
    // Automatic callback flow for local environments
    spin.update("Opening browser...");
    await openUrl(authorizeUrl);

    spin.update(`Waiting for callback on port ${DEFAULT_REDIRECT_PORT}...`);

    const callback = await waitForLocalCallback({
      redirectUri,
      expectedState: flowState.state,
      onProgress: (msg) => spin.update(msg),
    });

    if ("error" in callback) {
      spin.stop("OAuth failed");

      // Offer manual fallback
      const tryManual = await prompter.confirm({
        message: "Automatic callback failed. Enter redirect URL manually?",
      });

      if (!tryManual) {
        runtime.error(callback.error);
        return false;
      }

      const input = await prompter.text({
        message: "Paste the redirect URL",
        placeholder: `${redirectUri}?code=...&state=...`,
        validate: (value) => (value?.trim() ? undefined : "Required"),
      });

      const parsed = parseOAuthCallbackInput(String(input), flowState.state);
      if ("error" in parsed) {
        runtime.error(parsed.error);
        return false;
      }

      code = parsed.code;
      receivedState = parsed.state;
    } else {
      code = callback.code;
      receivedState = callback.state;
    }
  }

  spin.update("Exchanging code for tokens...");

  // Complete the OAuth flow
  const result = await completeOAuthFlow({
    flowState,
    code,
    receivedState,
    clientId,
    clientSecret,
  });

  if (!result.success) {
    spin.stop("OAuth failed");
    runtime.error(result.error ?? "Unknown error");
    return false;
  }

  spin.stop(`${provider.label} connected`);

  // Show success info
  const userLabel = result.userInfo?.email ?? result.userInfo?.username ?? result.userInfo?.name;
  if (userLabel) {
    runtime.log(`Connected as: ${theme.accent(userLabel)}`);
  }

  if (result.grantedScopes && result.grantedScopes.length > 0) {
    runtime.log(`Granted scopes: ${result.grantedScopes.join(", ")}`);
  }

  return true;
}

/**
 * Interactive scope selection for a provider.
 */
async function selectScopes(
  prompter: WizardPrompter,
  provider: import("../providers/connections/types.js").ConnectionProvider,
): Promise<string[]> {
  const presets = getPresetsForProvider(provider.id);

  if (presets.length > 0) {
    // Offer preset selection
    const presetChoices = [
      { value: "_custom", label: "Custom (select individual scopes)" },
      ...presets.map((p) => ({
        value: p.id,
        label: `${p.label} - ${p.description ?? ""}`,
      })),
    ];

    const selectedPreset = await prompter.select({
      message: `Select permission level for ${provider.label}`,
      options: presetChoices,
    });

    if (selectedPreset !== "_custom") {
      const scopes = getScopesForPreset(provider.id, String(selectedPreset));
      return scopes ?? getDefaultScopes(provider.id);
    }
  }

  // Custom scope selection
  const scopeChoices = provider.oauth.scopes.map((scope) => ({
    value: scope.id,
    label: `${scope.label}${scope.required ? " (required)" : scope.recommended ? " (recommended)" : ""}`,
    hint: scope.description,
  }));

  // Pre-select required and recommended scopes
  const initialValues = provider.oauth.scopes
    .filter((scope) => scope.required || scope.recommended)
    .map((scope) => scope.id);

  const selected = await prompter.multiselect({
    message: "Select permissions",
    options: scopeChoices,
    initialValues,
  });

  return Array.isArray(selected) ? selected.map(String) : [String(selected)];
}

/**
 * Show OAuth setup help for a provider.
 */
async function showOAuthSetupHelp(
  prompter: WizardPrompter,
  provider: import("../providers/connections/types.js").ConnectionProvider,
): Promise<void> {
  const clientIdEnv = provider.oauth.clientIdEnvVar ?? "CLIENT_ID";
  const clientSecretEnv = provider.oauth.clientSecretEnvVar ?? "CLIENT_SECRET";

  const helpText = [
    `To connect ${provider.label}, you need to:`,
    "",
    "1. Register an OAuth application with the provider",
    "2. Set the following environment variables:",
    `   ${clientIdEnv}=your_client_id`,
    clientSecretEnv ? `   ${clientSecretEnv}=your_client_secret` : "",
    "",
    "Redirect URIs to configure:",
    `   http://127.0.0.1:${DEFAULT_REDIRECT_PORT}${provider.oauth.defaultRedirectPath ?? "/oauth/callback"}`,
    `   http://localhost:${DEFAULT_REDIRECT_PORT}${provider.oauth.defaultRedirectPath ?? "/oauth/callback"}`,
  ]
    .filter(Boolean)
    .join("\n");

  await prompter.note(helpText, "OAuth Setup Required");
}

/**
 * Handle `clawdbrain connections status [provider]` command.
 */
export async function connectionsStatus(
  params: ConnectionsCommandParams & {
    providerId?: string;
  },
): Promise<boolean> {
  const { runtime, agentDir, providerId } = params;

  if (providerId) {
    // Show status for specific provider
    const status = getConnectionStatus(providerId, agentDir);
    if (!status) {
      runtime.error(`Unknown provider: ${providerId}`);
      return false;
    }

    runtime.log(`\n${theme.heading(status.label)}`);
    runtime.log(
      `Status: ${status.connected ? theme.success("Connected") : theme.muted("Not connected")}`,
    );

    if (status.connected) {
      const userLabel =
        status.userInfo?.email ?? status.userInfo?.username ?? status.userInfo?.name;
      if (userLabel) {
        runtime.log(`Account: ${userLabel}`);
      }

      if (status.grantedScopes && status.grantedScopes.length > 0) {
        runtime.log(`Scopes: ${status.grantedScopes.join(", ")}`);
      }

      if (status.expiresAt) {
        const expiresDate = new Date(status.expiresAt);
        const isExpired = status.isExpired;
        runtime.log(
          `Token expires: ${expiresDate.toISOString()}${isExpired ? theme.error(" (EXPIRED)") : ""}`,
        );
      }
    }

    return true;
  }

  // Show status for all providers
  const statuses = getAllConnectionStatuses(agentDir);

  if (statuses.length === 0) {
    runtime.log("No connection providers available.");
    return true;
  }

  const rows = statuses.map((status) => {
    const userLabel =
      status.userInfo?.email ?? status.userInfo?.username ?? status.userInfo?.name ?? "-";
    const scopeCount = status.grantedScopes?.length ?? 0;
    const scopeLabel = scopeCount > 0 ? `${scopeCount} scope${scopeCount > 1 ? "s" : ""}` : "-";

    return {
      provider: status.label,
      status: status.connected
        ? status.isExpired
          ? theme.warn("Expired")
          : theme.success("Connected")
        : theme.muted("Not connected"),
      account: status.connected ? userLabel : "-",
      scopes: status.connected ? scopeLabel : "-",
    };
  });

  runtime.log(
    "\n" +
      renderTable({
        columns: [
          { key: "provider", header: "Provider", minWidth: 15 },
          { key: "status", header: "Status", minWidth: 12 },
          { key: "account", header: "Account", minWidth: 20 },
          { key: "scopes", header: "Scopes", minWidth: 10 },
        ],
        rows,
      }).trimEnd(),
  );
  return true;
}

/**
 * Handle `clawdbrain connections logout <provider>` command.
 */
export async function connectionsLogout(
  params: ConnectionsCommandParams & {
    providerId: string;
  },
): Promise<boolean> {
  const { prompter, runtime, agentDir, providerId } = params;

  const provider = getConnectionProvider(providerId);
  if (!provider) {
    const available = getConnectionProviderIds().join(", ");
    runtime.error(`Unknown provider: ${providerId}`);
    runtime.log(`Available providers: ${available}`);
    return false;
  }

  const status = getConnectionStatus(providerId, agentDir);
  if (!status?.connected) {
    runtime.log(`${provider.label} is not connected.`);
    return true;
  }

  const confirm = await prompter.confirm({
    message: `Disconnect from ${provider.label}?`,
  });

  if (!confirm) {
    return false;
  }

  const removed = removeConnectionCredential(providerId, agentDir);
  if (removed) {
    runtime.log(`${theme.success("Disconnected")} from ${provider.label}`);
  } else {
    runtime.error("Failed to remove credentials");
    return false;
  }

  return true;
}

/**
 * Handle `clawdbrain connections list` command.
 */
export async function connectionsList(params: ConnectionsCommandParams): Promise<boolean> {
  const { runtime } = params;

  const providers = getAllConnectionProviders();

  if (providers.length === 0) {
    runtime.log("No connection providers available.");
    return true;
  }

  runtime.log("\nAvailable connection providers:\n");

  for (const provider of providers) {
    runtime.log(`  ${theme.accent(provider.id.padEnd(12))} ${provider.label}`);

    const presets = provider.oauth.presets ?? [];
    if (presets.length > 0) {
      runtime.log(`    Presets: ${presets.map((p) => p.id).join(", ")}`);
    }
  }

  runtime.log("\nUsage:");
  runtime.log("  clawdbrain connections login <provider> [--preset <preset>]");
  runtime.log("  clawdbrain connections status [provider]");
  runtime.log("  clawdbrain connections logout <provider>");

  return true;
}
