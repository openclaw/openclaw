import { withProgress } from "../progress.js";

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
  try {
    const result = await withProgress(
      {
        label: "Checking gateway status...",
        indeterminate: true,
        enabled: opts.json !== true,
      },
      async () => {
        if (opts.requireRpc) {
          const { callGateway } = await import("../../gateway/call.js");
          await callGateway({
            url: opts.url,
            token: opts.token,
            password: opts.password,
            tlsFingerprint: opts.tlsFingerprint,
            method: "status",
            timeoutMs: opts.timeoutMs,
            ...(opts.configPath ? { configPath: opts.configPath } : {}),
          });
          return { ok: true } as const;
        }
        const { probeGateway } = await import("../../gateway/probe.js");
        return await probeGateway({
          url: opts.url,
          auth: {
            token: opts.token,
            password: opts.password,
          },
          tlsFingerprint: opts.tlsFingerprint,
          timeoutMs: opts.timeoutMs,
          includeDetails: false,
        });
      },
    );
    if (result.ok) {
      return { ok: true } as const;
    }
    const closeHint = result.close
      ? `gateway closed (${result.close.code}): ${result.close.reason}`
      : null;
    return {
      ok: false,
      error: result.error ?? closeHint ?? "gateway probe failed",
    } as const;
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    } as const;
  }
}
