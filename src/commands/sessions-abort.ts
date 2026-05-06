import { getRuntimeConfig } from "../config/config.js";
import { resolveConfigPath } from "../config/paths.js";
import {
  buildGatewayConnectionDetails,
  ensureExplicitGatewayAuth,
  isGatewayTransportError,
} from "../gateway/call.js";
import { resolveGatewayCredentialsWithSecretInputs } from "../gateway/credentials-secret-inputs.js";
import { formatErrorMessage } from "../infra/errors.js";
import { type RuntimeEnv, writeRuntimeJson } from "../runtime.js";
import { normalizeOptionalString } from "../shared/string-coerce.js";

export type SessionsAbortCommandOptions = {
  sessionKey: string;
  force?: boolean;
  reason?: string;
  json?: boolean;
  url?: string;
  token?: string;
  timeout?: string;
};

type SessionsAbortResponse = {
  aborted?: boolean;
  previousStatus?: string;
  wasInMemory?: boolean;
  forceKilled?: boolean;
  ok?: boolean;
  error?: {
    type?: string;
    message?: string;
  };
};

function parseTimeoutMs(value: string | undefined): number {
  if (value === undefined) {
    return 30_000;
  }
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error("--timeout must be a positive integer (milliseconds)");
  }
  return parsed;
}

function resolveHttpEndpointUrl(wsUrl: string, sessionKey: string): string {
  const url = new URL(wsUrl);
  if (url.protocol === "ws:") {
    url.protocol = "http:";
  } else if (url.protocol === "wss:") {
    url.protocol = "https:";
  } else if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error(`unsupported gateway URL protocol: ${url.protocol}`);
  }
  url.pathname = `/api/sessions/${encodeURIComponent(sessionKey)}/abort`;
  url.search = "";
  url.hash = "";
  return url.toString();
}

function resolveAbortErrorMessage(status: number, body: SessionsAbortResponse | undefined): string {
  const message = normalizeOptionalString(body?.error?.message);
  if (status === 404) {
    return "session not found";
  }
  return message
    ? `gateway abort failed (${status}): ${message}`
    : `gateway abort failed (${status})`;
}

function resolveUrlOverride(opts: SessionsAbortCommandOptions): {
  urlOverride?: string;
  urlOverrideSource?: "cli" | "env";
} {
  const cliUrl = normalizeOptionalString(opts.url);
  if (cliUrl) {
    return { urlOverride: cliUrl, urlOverrideSource: "cli" };
  }
  const envUrl = normalizeOptionalString(process.env.OPENCLAW_GATEWAY_URL);
  if (envUrl) {
    return { urlOverride: envUrl, urlOverrideSource: "env" };
  }
  return {};
}

async function postAbortRequest(opts: SessionsAbortCommandOptions): Promise<SessionsAbortResponse> {
  const cfg = getRuntimeConfig();
  const connection = buildGatewayConnectionDetails({ config: cfg, url: opts.url });
  const explicitAuth = { token: normalizeOptionalString(opts.token) };
  const credentials = await resolveGatewayCredentialsWithSecretInputs({
    config: cfg,
    explicitAuth,
    env: process.env,
  });
  const { urlOverride, urlOverrideSource } = resolveUrlOverride(opts);
  ensureExplicitGatewayAuth({
    urlOverride,
    urlOverrideSource,
    explicitAuth,
    resolvedAuth: credentials,
    errorHint: "Fix: pass --token or configure gateway auth.",
    configPath: resolveConfigPath(process.env),
  });

  const endpoint = resolveHttpEndpointUrl(connection.url, opts.sessionKey);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), parseTimeoutMs(opts.timeout));
  try {
    const headers: Record<string, string> = {
      "Content-Type": "application/json; charset=utf-8",
    };
    if (credentials.token) {
      headers.Authorization = `Bearer ${credentials.token}`;
    } else if (credentials.password) {
      headers.Authorization = `Bearer ${credentials.password}`;
    }
    const response = await fetch(endpoint, {
      method: "POST",
      headers,
      body: JSON.stringify({
        force: opts.force === true,
        ...(normalizeOptionalString(opts.reason)
          ? { reason: normalizeOptionalString(opts.reason) }
          : {}),
      }),
      signal: controller.signal,
    });
    const parsed = (await response.json().catch(() => undefined)) as
      | SessionsAbortResponse
      | undefined;
    if (!response.ok) {
      throw new Error(resolveAbortErrorMessage(response.status, parsed));
    }
    return parsed ?? {};
  } finally {
    clearTimeout(timeout);
  }
}

export async function sessionsAbortCommand(opts: SessionsAbortCommandOptions, runtime: RuntimeEnv) {
  try {
    const result = await postAbortRequest(opts);
    if (opts.json) {
      writeRuntimeJson(runtime, result);
      return;
    }
    const previous = result.previousStatus ?? "unknown";
    const memory = result.wasInMemory ? "yes" : "no";
    const forced =
      opts.force === true
        ? ` Force kill: ${result.forceKilled ? "attempted and matched" : "no matching cancellable run"}.`
        : "";
    runtime.log(
      `Aborted session ${opts.sessionKey} (previous status: ${previous}; in memory: ${memory}).${forced}`,
    );
  } catch (error) {
    if (isGatewayTransportError(error)) {
      runtime.error(`gateway unavailable: ${error.message}`);
    } else {
      runtime.error(formatErrorMessage(error));
    }
    runtime.exit(1);
  }
}
