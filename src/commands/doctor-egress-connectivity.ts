/**
 * Doctor diagnostic check for outbound network, DNS, TLS, and proxy egress.
 *
 * Designed to diagnose reachability issues to model providers and channels
 * without hanging or throwing in air-gapped, offline, or restricted environments.
 */
import dns from "node:dns/promises";
import tls from "node:tls";
import { note } from "../../packages/terminal-core/src/note.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  hasEnvHttpProxyConfigured,
  hasProxyEnvConfigured,
  resolveEnvHttpProxyUrl,
} from "../infra/net/proxy-env.js";

export const DEFAULT_EGRESS_PROBE_HOSTS = [
  "docs.openclaw.ai",
  "api.openai.com",
  "api.anthropic.com",
] as const;

export const DEFAULT_PROBE_TIMEOUT_MS = 2_500;

export type EgressProbeStatus =
  | "ok"
  | "dns_failed"
  | "connect_timeout"
  | "connect_refused"
  | "tls_cert_error"
  | "tls_handshake_failed"
  | "unknown_error";

export type EgressProbeResult = {
  host: string;
  port: number;
  status: EgressProbeStatus;
  durationMs: number;
  errorDetail?: string;
};

export type EgressDiagnosticReport = {
  proxyConfigured: boolean;
  proxySyntaxValid: boolean;
  malformedProxyKeys: string[];
  probes: EgressProbeResult[];
  allPassed: boolean;
  offline: boolean;
  warnings: string[];
};

export type EgressDnsResolver = (host: string) => Promise<string[]>;
export type EgressTlsConnector = (params: {
  host: string;
  port: number;
  timeoutMs: number;
}) => Promise<{ ok: boolean; error?: Error }>;

/** Redacts sensitive basic-auth credentials from proxy URLs before diagnostic printing. */
export function sanitizeProxyUrl(rawUrl: string): string {
  try {
    const parsed = new URL(rawUrl);
    if (parsed.password) {
      parsed.password = "***";
    }
    return parsed.toString();
  } catch {
    return "[malformed proxy URL]";
  }
}

/** Check if configured proxy environment variables have valid URL syntax. */
export function inspectProxyEnvironmentSanity(env: NodeJS.ProcessEnv): {
  valid: boolean;
  malformedKeys: string[];
} {
  const malformedKeys: string[] = [];
  const proxyKeys = [
    "HTTP_PROXY",
    "HTTPS_PROXY",
    "ALL_PROXY",
    "http_proxy",
    "https_proxy",
    "all_proxy",
  ];
  for (const key of proxyKeys) {
    const val = env[key]?.trim();
    if (!val) {
      continue;
    }
    try {
      const parsed = new URL(val);
      if (!parsed.protocol || !parsed.hostname) {
        malformedKeys.push(key);
      }
    } catch {
      malformedKeys.push(key);
    }
  }
  return {
    valid: malformedKeys.length === 0,
    malformedKeys,
  };
}

async function defaultDnsResolver(host: string): Promise<string[]> {
  const res = await dns.lookup(host, { all: true });
  return res.map((r) => r.address);
}

async function defaultTlsConnector(params: {
  host: string;
  port: number;
  timeoutMs: number;
}): Promise<{ ok: boolean; error?: Error }> {
  return await new Promise((resolve) => {
    let settled = false;
    const socket = tls.connect({
      host: params.host,
      port: params.port,
      servername: params.host,
      timeout: params.timeoutMs,
    });

    const finish = (ok: boolean, error?: Error) => {
      if (settled) {
        return;
      }
      settled = true;
      socket.destroy();
      resolve({ ok, error });
    };

    socket.once("secureConnect", () => finish(true));
    socket.once("timeout", () => {
      const err = Object.assign(new Error("connection timed out"), { code: "ETIMEDOUT" });
      finish(false, err);
    });
    socket.once("error", (err) => finish(false, err));
  });
}

/**
 * Classifies an error into a standardized probe status.
 */
export function classifyProbeError(err: unknown): { status: EgressProbeStatus; detail: string } {
  if (!err || typeof err !== "object") {
    return { status: "unknown_error", detail: String(err) };
  }
  const code = "code" in err && typeof err.code === "string" ? err.code : "";
  const message =
    "message" in err && typeof err.message === "string"
      ? err.message
      : err instanceof Error
        ? err.message
        : "";

  if (code === "ENOTFOUND" || code === "EAI_AGAIN") {
    return { status: "dns_failed", detail: `DNS lookup failed (${code})` };
  }
  if (code === "ETIMEDOUT" || message.includes("timed out")) {
    return { status: "connect_timeout", detail: "Connection timed out" };
  }
  if (code === "ECONNREFUSED") {
    return { status: "connect_refused", detail: "Connection refused by host or proxy" };
  }
  if (
    code === "UNABLE_TO_VERIFY_LEAF_SIGNATURE" ||
    code === "CERT_HAS_EXPIRED" ||
    code === "DEPTH_ZERO_SELF_SIGNED_CERT" ||
    code === "SELF_SIGNED_CERT_IN_CHAIN" ||
    message.includes("certificate")
  ) {
    return {
      status: "tls_cert_error",
      detail: `TLS certificate verification failed (${code || message})`,
    };
  }
  return { status: "tls_handshake_failed", detail: message || code || "Handshake failed" };
}

/**
 * Run a probe against a single host with DNS and TLS checks.
 */
export async function probeHostEgress(
  host: string,
  port = 443,
  timeoutMs = DEFAULT_PROBE_TIMEOUT_MS,
  dnsResolver: EgressDnsResolver = defaultDnsResolver,
  tlsConnector: EgressTlsConnector = defaultTlsConnector,
): Promise<EgressProbeResult> {
  const start = Date.now();

  try {
    const addresses = await dnsResolver(host);
    if (!addresses || addresses.length === 0) {
      return {
        host,
        port,
        status: "dns_failed",
        durationMs: Date.now() - start,
        errorDetail: "DNS returned no addresses",
      };
    }
  } catch (err) {
    const { status, detail } = classifyProbeError(err);
    return {
      host,
      port,
      status,
      durationMs: Date.now() - start,
      errorDetail: detail,
    };
  }

  try {
    const result = await tlsConnector({ host, port, timeoutMs });
    if (result.ok) {
      return {
        host,
        port,
        status: "ok",
        durationMs: Date.now() - start,
      };
    }
    const { status, detail } = classifyProbeError(result.error);
    return {
      host,
      port,
      status,
      durationMs: Date.now() - start,
      errorDetail: detail,
    };
  } catch (err) {
    const { status, detail } = classifyProbeError(err);
    return {
      host,
      port,
      status,
      durationMs: Date.now() - start,
      errorDetail: detail,
    };
  }
}

/**
 * Executes comprehensive egress diagnostics across configured proxies and key endpoints.
 */
export async function diagnoseEgressConnectivity(params: {
  cfg?: OpenClawConfig;
  env?: NodeJS.ProcessEnv;
  hosts?: readonly string[];
  timeoutMs?: number;
  dnsResolver?: EgressDnsResolver;
  tlsConnector?: EgressTlsConnector;
}): Promise<EgressDiagnosticReport> {
  const env = params.env ?? process.env;
  const hosts = params.hosts ?? DEFAULT_EGRESS_PROBE_HOSTS;
  const timeoutMs = params.timeoutMs ?? DEFAULT_PROBE_TIMEOUT_MS;
  const dnsResolver = params.dnsResolver ?? defaultDnsResolver;
  const tlsConnector = params.tlsConnector ?? defaultTlsConnector;

  const proxySanity = inspectProxyEnvironmentSanity(env);
  const proxyConfigured = hasProxyEnvConfigured(env);

  const probePromises = hosts.map((h) =>
    probeHostEgress(h, 443, timeoutMs, dnsResolver, tlsConnector),
  );
  const settled = await Promise.all(probePromises);

  const passedCount = settled.filter((p) => p.status === "ok").length;
  const allPassed = passedCount === settled.length;
  const allFailed = passedCount === 0;

  const warnings: string[] = [];

  if (!proxySanity.valid) {
    warnings.push(
      `Malformed proxy environment variable(s) detected: ${proxySanity.malformedKeys.join(", ")}. URLs must include a valid protocol and host (e.g. http://proxy.example.com:8080).`,
    );
  }

  if (allFailed && settled.length > 0) {
    const hasDnsFailure = settled.some((p) => p.status === "dns_failed");
    const hasCertFailure = settled.some((p) => p.status === "tls_cert_error");
    const hasTimeout = settled.some((p) => p.status === "connect_timeout");

    if (hasCertFailure) {
      warnings.push(
        "TLS certificate verification failed across external endpoints. If you are behind an enterprise TLS inspection proxy, configure `NODE_EXTRA_CA_CERTS=/path/to/rootCA.crt`.",
      );
    } else if (hasDnsFailure) {
      warnings.push(
        "DNS resolution failed for external endpoints. Check your internet connection, VPN, or system resolver settings in `/etc/resolv.conf`.",
      );
    } else if (hasTimeout) {
      warnings.push(
        "Outbound HTTPS connections (port 443) timed out. Check your firewall rules or ensure your outbound proxy is reachable.",
      );
    } else {
      warnings.push(
        "Unable to establish outbound connections to AI providers or documentation services. The environment appears offline or restricted.",
      );
    }
  } else if (!allPassed) {
    const failedHosts = settled.filter((p) => p.status !== "ok");
    const details = failedHosts.map((f) => `${f.host} (${f.errorDetail ?? f.status})`).join(", ");
    warnings.push(`Partial outbound connectivity: failed connecting to ${details}.`);
  }

  return {
    proxyConfigured,
    proxySyntaxValid: proxySanity.valid,
    malformedProxyKeys: proxySanity.malformedKeys,
    probes: settled,
    allPassed,
    offline: allFailed && settled.length > 0,
    warnings,
  };
}

/**
 * Emits actionable doctor diagnostics for outbound network and proxy egress when issues are found.
 */
export async function noteEgressConnectivityDiagnostic(params: {
  cfg?: OpenClawConfig;
  env?: NodeJS.ProcessEnv;
  noteFn?: typeof note;
  diagnoseFn?: typeof diagnoseEgressConnectivity;
}): Promise<void> {
  const diagnose = params.diagnoseFn ?? diagnoseEgressConnectivity;
  const report = await diagnose(params);

  if (report.warnings.length === 0 && report.allPassed) {
    return;
  }

  const lines: string[] = [];

  for (const warning of report.warnings) {
    lines.push(`- ${warning}`);
  }

  if (report.proxyConfigured && hasEnvHttpProxyConfigured("https", params.env ?? process.env)) {
    const rawProxy = resolveEnvHttpProxyUrl("https", params.env ?? process.env);
    if (rawProxy) {
      lines.push(`- Outbound HTTPS traffic routes through proxy: ${sanitizeProxyUrl(rawProxy)}`);
    }
  }

  if (lines.length > 0) {
    (params.noteFn ?? note)(lines.join("\n"), "Outbound connectivity");
  }
}
