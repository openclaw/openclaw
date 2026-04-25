import { formatErrorMessage } from "../../infra/errors.js";
import { withProgress } from "../progress.js";

type GatewayStatusProbeKind = "connect" | "read";

let probeGatewayModulePromise: Promise<typeof import("../../gateway/probe.js")> | undefined;

async function loadProbeGatewayModule(): Promise<typeof import("../../gateway/probe.js")> {
  probeGatewayModulePromise ??= import("../../gateway/probe.js");
  return await probeGatewayModulePromise;
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
  tlsFingerprint?: string;
  timeoutMs: number;
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
        const probe = await probeGateway({
          url: opts.url,
          auth: {
            token: opts.token,
            password: opts.password,
          },
          tlsFingerprint: opts.tlsFingerprint,
          timeoutMs: opts.timeoutMs,
          includeDetails: opts.requireRpc === true,
          detailLevel: opts.requireRpc === true ? "full" : "none",
        });
        return probe;
      },
    );
    const auth = result.auth;
    if (result.ok) {
      return {
        ok: true,
        kind,
        capability:
          kind === "read"
            ? auth?.capability && auth.capability !== "unknown"
              ? auth.capability
              : // A successful detailed probe performs read RPCs, so it proves read access
                // even when hello metadata cannot recover richer scope metadata.
                "read_only"
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
