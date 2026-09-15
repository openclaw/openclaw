// Read-only Tailscale pairing preflight findings.
import os from "node:os";
import { redactSensitiveUrlLikeString } from "@openclaw/net-policy/redact-sensitive-url";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { truncateUtf16Safe } from "@openclaw/normalization-core/utf16-slice";
import { sanitizeTerminalText } from "../../packages/terminal-core/src/safe-text.js";
import { resolveGatewayPort } from "../config/paths.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { HealthFinding } from "../flows/health-checks.js";
import { probeGateway as probeGatewayEndpoint } from "../gateway/probe.js";
import { racePromiseWithAbortSignal } from "../infra/abort-signal.js";
import { readResponseWithLimit } from "../infra/http-body.js";
import {
  resolveConfiguredPairingPublicUrl,
  resolvePairingGatewayUrl,
} from "../pairing/setup-code.js";
import { runUtf8CommandWithTimeout } from "../process/exec.js";
import {
  inspectTailscaleServeRoutesWithRunner,
  type TailscaleStatusCommandRunner,
} from "../shared/tailscale-status.js";
import { buildTimeoutAbortSignal } from "../utils/fetch-timeout.js";
import {
  TAILSCALE_PAIRING_CHECK_ID,
  collectTailscalePairingConfigurationFindings,
  pairingTarget,
  analyzePairingEndpoint,
} from "./doctor-tailscale-pairing-config.js";

const HTTP_LIVENESS_MAX_BODY_BYTES = 4 * 1024;

type CollectTailscalePairingHealthParams = {
  cfg: OpenClawConfig;
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
  runCommandWithTimeout?: TailscaleStatusCommandRunner;
  networkInterfaces?: () => ReturnType<typeof os.networkInterfaces>;
  fetchFn?: typeof fetch;
  probeGateway?: typeof probeGatewayEndpoint;
};

function healthUrlForPairingEndpoint(url: URL): string {
  const protocol = url.protocol === "wss:" ? "https:" : "http:";
  const basePath = url.pathname === "/" ? "" : url.pathname.replace(/\/$/, "");
  return `${protocol}//${url.host}${basePath}/healthz`;
}

async function probeHttpLiveness(params: {
  url: URL;
  signal?: AbortSignal;
  fetchFn: typeof fetch;
}): Promise<"live" | "unverified"> {
  try {
    const response = await params.fetchFn(healthUrlForPairingEndpoint(params.url), {
      method: "GET",
      redirect: "manual",
      headers: { accept: "application/json" },
      signal: params.signal,
    });
    if (response.status !== 200) {
      return "unverified";
    }
    const body: unknown = JSON.parse(
      (await readResponseWithLimit(response, HTTP_LIVENESS_MAX_BODY_BYTES)).toString("utf8"),
    );
    return isRecord(body) && body.ok === true && body.status === "live" ? "live" : "unverified";
  } catch {
    return "unverified";
  }
}

function sanitizeProbeReason(value: string | null | undefined): string | undefined {
  const cleaned = value ? redactSensitiveUrlLikeString(sanitizeTerminalText(value)).trim() : "";
  return cleaned ? truncateUtf16Safe(cleaned, 240) : undefined;
}

function runtimeEvidenceFindings(params: {
  url: URL;
  liveness: "live" | "unverified";
  probe: Awaited<ReturnType<typeof probeGatewayEndpoint>>;
}): HealthFinding[] {
  const target = pairingTarget(params.url);
  const findings: HealthFinding[] = [
    params.liveness === "live"
      ? {
          checkId: TAILSCALE_PAIRING_CHECK_ID,
          severity: "info",
          message:
            "The configured endpoint returned the Gateway HTTP liveness contract; this does not prove WebSocket authentication or phone reachability.",
          target,
          requirement: "http-liveness",
        }
      : {
          checkId: TAILSCALE_PAIRING_CHECK_ID,
          severity: "warning",
          message:
            "The configured endpoint did not return the expected Gateway HTTP liveness contract; HTTP liveness is unverified.",
          target,
          requirement: "http-liveness-unverified",
          fixHint:
            "Check the exact published path and `/healthz` response without relying on status 200 alone.",
        },
  ];

  const reason = sanitizeProbeReason(params.probe.close?.reason ?? params.probe.error);
  if (
    reason?.includes("proxy_attribution_required") ||
    params.probe.error?.includes("proxy_attribution_required")
  ) {
    findings.push({
      checkId: TAILSCALE_PAIRING_CHECK_ID,
      severity: "error",
      message:
        "The Gateway rejected the WebSocket upgrade because the immediate proxy could not be attributed, regardless of HTTP liveness.",
      path: "gateway.trustedProxies",
      target,
      requirement: "proxy-attribution-runtime",
      fixHint:
        "Trust only the immediate proxy address and make that proxy overwrite or safely rebuild forwarded client headers.",
    });
    return findings;
  }

  const authenticated =
    params.probe.ok && (params.probe.auth.role !== null || params.probe.auth.scopes.length > 0);
  if (authenticated) {
    findings.push({
      checkId: TAILSCALE_PAIRING_CHECK_ID,
      severity: "info",
      message:
        "The configured endpoint completed an authenticated read-only Gateway probe from this host; phone tailnet access still requires separate verification.",
      target,
      requirement: "gateway-authenticated",
    });
  } else if (params.probe.gatewayReached === true) {
    findings.push({
      checkId: TAILSCALE_PAIRING_CHECK_ID,
      severity: "warning",
      message: `The endpoint returned a correlated Gateway response, but authentication was not verified${reason ? ` (${reason})` : ""}.`,
      target,
      requirement: "gateway-auth-unverified",
      fixHint:
        "Verify normal Gateway authentication and device approval; this diagnostic does not create pairing requests.",
    });
  } else {
    findings.push({
      checkId: TAILSCALE_PAIRING_CHECK_ID,
      severity: "warning",
      message: `No correlated Gateway WebSocket response was observed${reason ? ` (${reason})` : ""}.`,
      target,
      requirement: "gateway-unreachable",
      fixHint: "Check Tailscale connectivity, the published route, TLS, and the Gateway listener.",
    });
  }
  return findings;
}

function deadlineFinding(url: URL | null): HealthFinding {
  return {
    checkId: TAILSCALE_PAIRING_CHECK_ID,
    severity: "warning",
    message: "The Tailscale pairing diagnostic reached its overall deadline.",
    ...(url ? { target: pairingTarget(url) } : {}),
    requirement: "diagnostic-deadline",
    fixHint: "Run the focused check again after confirming the Tailscale CLI and endpoint respond.",
  };
}

/** Runs the opt-in, read-only Tailscale pairing preflight under one deadline. */
export async function collectTailscalePairingHealthFindings(
  params: CollectTailscalePairingHealthParams,
): Promise<readonly HealthFinding[]> {
  const env = params.env ?? process.env;
  const timeoutMs = params.timeoutMs ?? 10_000;
  const operationController = new AbortController();
  const { signal, cleanup } = buildTimeoutAbortSignal({
    timeoutMs,
    signal: operationController.signal,
    operation: "doctor-tailscale-pairing",
  });
  const runCommandWithTimeout: TailscaleStatusCommandRunner =
    params.runCommandWithTimeout ??
    ((argv, options) =>
      runUtf8CommandWithTimeout(argv, {
        ...options,
        signal,
        maxOutputBytes: 400_000,
      }));
  const findings: HealthFinding[] = [];
  let url: URL | null = null;

  try {
    const [pairingUrl, serveInspection] = await racePromiseWithAbortSignal(
      Promise.all([
        resolvePairingGatewayUrl(params.cfg, {
          env,
          publicUrl: resolveConfiguredPairingPublicUrl(params.cfg),
          runCommandWithTimeout,
          networkInterfaces: params.networkInterfaces ?? os.networkInterfaces,
        }),
        inspectTailscaleServeRoutesWithRunner(runCommandWithTimeout),
      ]),
      signal,
    );
    const endpoint = analyzePairingEndpoint(pairingUrl);
    url = endpoint.url;
    findings.push(
      ...collectTailscalePairingConfigurationFindings({
        cfg: params.cfg,
        gatewayPort: resolveGatewayPort(params.cfg, env),
        endpoint,
        serveInspection,
      }),
    );
    if (!url || endpoint.mobileUrlError) {
      return findings;
    }

    const target = pairingTarget(url);
    const remoteTlsFingerprint =
      pairingUrl.source === "gateway.remote.url"
        ? params.cfg.gateway?.remote?.tlsFingerprint
        : undefined;
    const [liveness, probe] = await racePromiseWithAbortSignal(
      Promise.all([
        probeHttpLiveness({
          url,
          signal,
          fetchFn: params.fetchFn ?? fetch,
        }),
        (params.probeGateway ?? probeGatewayEndpoint)({
          url: target,
          timeoutMs,
          detailLevel: "none",
          suppressStoredDeviceAuth: true,
          auth: undefined,
          config: remoteTlsFingerprint
            ? {
                gateway: {
                  remote: { url: target, tlsFingerprint: remoteTlsFingerprint },
                },
              }
            : {},
          env,
          signal,
        }),
      ]),
      signal,
    );
    findings.push(...runtimeEvidenceFindings({ url, liveness, probe }));
    return findings;
  } catch (error) {
    if (signal?.aborted) {
      findings.push(deadlineFinding(url));
      return findings;
    }
    throw error;
  } finally {
    operationController.abort();
    cleanup();
  }
}
