import type { ChannelAccountSnapshot, ChannelStatusIssue } from "../types.js";
import { asString, isRecord } from "./shared.js";

type BlueBubblesAccountStatus = {
  accountId?: unknown;
  enabled?: unknown;
  configured?: unknown;
  running?: unknown;
  connected?: unknown;
  baseUrl?: unknown;
  webhookPath?: unknown;
  webhookRouteRegistered?: unknown;
  privateApi?: unknown;
  helperConnected?: unknown;
  serverVersion?: unknown;
  osVersion?: unknown;
  lastError?: unknown;
  probe?: unknown;
};

type BlueBubblesProbeResult = {
  ok?: boolean;
  status?: number | null;
  error?: string | null;
};

function readBlueBubblesAccountStatus(
  value: ChannelAccountSnapshot,
): BlueBubblesAccountStatus | null {
  if (!isRecord(value)) {
    return null;
  }
  return {
    accountId: value.accountId,
    enabled: value.enabled,
    configured: value.configured,
    running: value.running,
    connected: value.connected,
    baseUrl: value.baseUrl,
    webhookPath: value.webhookPath,
    webhookRouteRegistered: value.webhookRouteRegistered,
    privateApi: value.privateApi,
    helperConnected: value.helperConnected,
    serverVersion: value.serverVersion,
    osVersion: value.osVersion,
    lastError: value.lastError,
    probe: value.probe,
  };
}

function readBlueBubblesProbeResult(value: unknown): BlueBubblesProbeResult | null {
  if (!isRecord(value)) {
    return null;
  }
  return {
    ok: typeof value.ok === "boolean" ? value.ok : undefined,
    status: typeof value.status === "number" ? value.status : null,
    error: asString(value.error) ?? null,
  };
}

export function collectBlueBubblesStatusIssues(
  accounts: ChannelAccountSnapshot[],
): ChannelStatusIssue[] {
  const issues: ChannelStatusIssue[] = [];
  for (const entry of accounts) {
    const account = readBlueBubblesAccountStatus(entry);
    if (!account) {
      continue;
    }
    const accountId = asString(account.accountId) ?? "default";
    const enabled = account.enabled !== false;
    if (!enabled) {
      continue;
    }

    const configured = account.configured === true;
    const running = account.running === true;
    const connected = account.connected === true;
    const lastError = asString(account.lastError);
    const probe = readBlueBubblesProbeResult(account.probe);
    const webhookPath = asString(account.webhookPath);
    const webhookRouteRegistered =
      typeof account.webhookRouteRegistered === "boolean"
        ? account.webhookRouteRegistered
        : undefined;
    const privateApi = typeof account.privateApi === "boolean" ? account.privateApi : undefined;
    const helperConnected =
      typeof account.helperConnected === "boolean" ? account.helperConnected : undefined;
    const serverVersion = asString(account.serverVersion);
    const osVersion = asString(account.osVersion);

    // Check for unconfigured accounts
    if (!configured) {
      issues.push({
        channel: "bluebubbles",
        accountId,
        kind: "config",
        message: "Not configured (missing serverUrl or password).",
        fix: "Run: openclaw channels add bluebubbles --http-url <server-url> --password <password>",
      });
      continue;
    }

    // Check for probe failures
    if (probe && probe.ok === false) {
      const errorDetail = probe.error
        ? `: ${probe.error}`
        : probe.status
          ? ` (HTTP ${probe.status})`
          : "";
      issues.push({
        channel: "bluebubbles",
        accountId,
        kind: "runtime",
        message: `BlueBubbles server unreachable${errorDetail}`,
        fix: "Check that the BlueBubbles server is running and accessible. Verify serverUrl and password in your config.",
      });
    }

    if (probe?.ok === true && webhookRouteRegistered === false) {
      issues.push({
        channel: "bluebubbles",
        accountId,
        kind: "runtime",
        message: `BlueBubbles webhook route missing${webhookPath ? ` at ${webhookPath}` : ""}`,
        fix: "Restart the gateway and verify the BlueBubbles webhook path is registered on the live server.",
      });
    }

    if (probe?.ok === true && privateApi === false) {
      const suffix = osVersion ? ` (macOS ${osVersion})` : "";
      issues.push({
        channel: "bluebubbles",
        accountId,
        kind: "runtime",
        message: `BlueBubbles Private API disabled${suffix}`,
        fix: "Enable BlueBubbles Private API and re-check macOS accessibility/privacy prompts.",
      });
    }

    if (probe?.ok === true && helperConnected === false) {
      const versionSuffix = serverVersion ? ` (server ${serverVersion})` : "";
      issues.push({
        channel: "bluebubbles",
        accountId,
        kind: "runtime",
        message: `BlueBubbles helper disconnected${versionSuffix}`,
        fix: "Restart BlueBubbles and Messages.app, then confirm the Private API helper reconnects.",
      });
    }

    // Check for runtime errors
    if (running && lastError) {
      issues.push({
        channel: "bluebubbles",
        accountId,
        kind: "runtime",
        message: `Channel error: ${lastError}`,
        fix: "Check gateway logs for details. If the webhook is failing, verify the webhook URL is configured in BlueBubbles server settings.",
      });
    }

    if (running && !connected && probe?.ok === true) {
      issues.push({
        channel: "bluebubbles",
        accountId,
        kind: "runtime",
        message: "BlueBubbles running but not connected",
        fix: "Inspect webhook acceptance and BlueBubbles Private API helper state; ping alone is not enough for inbound health.",
      });
    }
  }
  return issues;
}
