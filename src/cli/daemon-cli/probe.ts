import type { OpenClawConfig } from "../../config/types.js";
import {
  applyLocalStatusRpcFallback,
  shouldUseDeviceIdentityForLocalStatusRpcFallback,
} from "../../gateway/local-status-rpc-fallback.js";
import { formatErrorMessage } from "../../infra/errors.js";
import { createLazyImportLoader } from "../../shared/lazy-promise.js";
import { withProgress } from "../progress.js";

type GatewayStatusProbeKind = "connect" | "read";

const probeGatewayModuleLoader = createLazyImportLoader(() => import("../../gateway/probe.js"));

async function loadProbeGatewayModule(): Promise<typeof import("../../gateway/probe.js")> {
  return await probeGatewayModuleLoader.load();
}

function resolveProbeFailureMessage(result: {
  error?: string | null;
  close?: { code: number; reason: string } | null;
}): string {
  const closeHint = result.close
    ? `gateway closed (${result.close.code}): ${result.close.reason}`
    : null;
  if (closeHint && (!result.error || result.error === "timeout")) {
    return closeHint;
  }
  return result.error ?? closeHint ?? "gateway probe failed";
}

export async function probeGatewayStatus(opts: {
  url: string;
  token?: string;
  password?: string;
  config?: OpenClawConfig;
  tlsFingerprint?: string;
  timeoutMs: number;
  preauthHandshakeTimeoutMs?: number;
  json?: boolean;
  requireRpc?: boolean;
  configPath?: string;
}) {
  const kind = (opts.requireRpc ? "read" : "connect") satisfies GatewayStatusProbeKind;
  try {
    const result = await withProgress(
      {
        label: "Checking gateway status...",
        indeterminate: true,
        enabled: opts.json !== true,
      },
      async () => {
        const { probeGateway } = await loadProbeGatewayModule();
        const probeOpts = {
          url: opts.url,
          auth: {
            token: opts.token,
            password: opts.password,
          },
          tlsFingerprint: opts.tlsFingerprint,
          ...(opts.preauthHandshakeTimeoutMs !== undefined
            ? { preauthHandshakeTimeoutMs: opts.preauthHandshakeTimeoutMs }
            : {}),
          timeoutMs: opts.timeoutMs,
          includeDetails: false,
        };
        if (opts.requireRpc) {
          const { callGateway } = await import("../../gateway/call.js");
          await callGateway({
            url: opts.url,
            token: opts.token,
            password: opts.password,
            tlsFingerprint: opts.tlsFingerprint,
            ...(opts.config ? { config: opts.config } : {}),
            method: "status",
            timeoutMs: opts.timeoutMs,
            ...(opts.configPath ? { configPath: opts.configPath } : {}),
          });
          const authProbe = await probeGateway(probeOpts).catch(() => null);
          return { ok: true as const, authProbe };
        }
        const initialProbe = await probeGateway(probeOpts);
        const hasSharedCredentials = Boolean(opts.token || opts.password);
        const useDeviceIdentityFallback =
          !hasSharedCredentials && shouldUseDeviceIdentityForLocalStatusRpcFallback(initialProbe);
        const fallbackProbe = await applyLocalStatusRpcFallback({
          gatewayMode: "local",
          gatewayUrl: opts.url,
          gatewayProbe: initialProbe,
          hasSharedCredentials,
          allowSharedCredentials: hasSharedCredentials,
          callStatus: async () => {
            const { callGateway } = await import("../../gateway/call.js");
            return await callGateway({
              url: opts.url,
              token: opts.token,
              password: opts.password,
              tlsFingerprint: opts.tlsFingerprint,
              ...(opts.config ? { config: opts.config } : {}),
              method: "status",
              timeoutMs: Math.min(1000, opts.timeoutMs),
              mode: "backend",
              clientName: "gateway-client",
              ...(useDeviceIdentityFallback
                ? { allowDeviceIdentityLoopbackUrlOverride: true }
                : hasSharedCredentials
                  ? {}
                  : {
                      deviceIdentity: null,
                      allowUnauthenticatedLoopbackUrlOverride: true,
                    }),
              ...(opts.configPath ? { configPath: opts.configPath } : {}),
            });
          },
        });
        return fallbackProbe ?? initialProbe;
      },
    );
    const auth = "auth" in result ? result.auth : result.authProbe?.auth;
    if (result.ok) {
      return {
        ok: true,
        kind,
        capability:
          kind === "read"
            ? auth?.capability && auth.capability !== "unknown"
              ? auth.capability
              : "read_only"
            : auth?.capability,
        auth,
      } as const;
    }
    return {
      ok: false,
      kind,
      capability: auth?.capability,
      auth,
      error: resolveProbeFailureMessage(result),
    } as const;
  } catch (err) {
    return {
      ok: false,
      kind,
      error: formatErrorMessage(err),
    } as const;
  }
}
