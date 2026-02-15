import type { DaemonLifecycleOptions } from "./types.js";
import { resolveGatewayService } from "../../daemon/service.js";
import { callGateway } from "../../gateway/call.js";
import { defaultRuntime } from "../../runtime.js";
import {
  runServiceRestart,
  runServiceStart,
  runServiceStop,
  runServiceUninstall,
} from "./lifecycle-core.js";
import { emitDaemonActionJson } from "./response.js";
import { renderGatewayServiceStartHints } from "./shared.js";

const DEFAULT_RESTART_DELAY_MS = 2000;

function parseOptionalDelayMs(raw: unknown): number | undefined {
  if (raw == null || raw === "") {
    return undefined;
  }
  if (typeof raw === "number" && Number.isFinite(raw)) {
    return Math.max(0, Math.floor(raw));
  }
  if (typeof raw === "string") {
    const parsed = Number(raw);
    if (Number.isFinite(parsed)) {
      return Math.max(0, Math.floor(parsed));
    }
  }
  return Number.NaN;
}

function failRestart(opts: DaemonLifecycleOptions, message: string): never {
  if (opts.json) {
    emitDaemonActionJson({
      ok: false,
      action: "restart",
      error: message,
    });
  } else {
    defaultRuntime.error(message);
  }
  defaultRuntime.exit(1);
}

function printRpcRestartScheduled(
  opts: DaemonLifecycleOptions,
  info: { mode: "soft" | "hard"; delayMs: number; reason?: string },
) {
  const message = `Gateway ${info.mode} restart scheduled via RPC (delay ${info.delayMs}ms${
    info.reason ? `, reason: ${info.reason}` : ""
  }).`;
  if (opts.json) {
    emitDaemonActionJson({
      ok: true,
      action: "restart",
      result: "scheduled",
      message,
    });
  } else {
    defaultRuntime.log(message);
  }
}

export async function runDaemonUninstall(opts: DaemonLifecycleOptions = {}) {
  return await runServiceUninstall({
    serviceNoun: "Gateway",
    service: resolveGatewayService(),
    opts,
    stopBeforeUninstall: true,
    assertNotLoadedAfterUninstall: true,
  });
}

export async function runDaemonStart(opts: DaemonLifecycleOptions = {}) {
  return await runServiceStart({
    serviceNoun: "Gateway",
    service: resolveGatewayService(),
    renderStartHints: renderGatewayServiceStartHints,
    opts,
  });
}

export async function runDaemonStop(opts: DaemonLifecycleOptions = {}) {
  return await runServiceStop({
    serviceNoun: "Gateway",
    service: resolveGatewayService(),
    opts,
  });
}

/**
 * Restart the gateway service.
 *
 * Behavior:
 * - Inside gateway process (OPENCLAW_IN_GATEWAY=1) and not --hard: use soft RPC restart.
 * - Otherwise: try RPC restart (hard by default), then fall back to supervisor restart.
 */
export async function runDaemonRestart(opts: DaemonLifecycleOptions = {}): Promise<boolean> {
  if (opts.soft && opts.hard) {
    failRestart(opts, "Cannot use --soft and --hard together.");
  }

  const delayMs = parseOptionalDelayMs(opts.delay);
  if (typeof delayMs === "number" && Number.isNaN(delayMs)) {
    failRestart(opts, `Invalid --delay value: ${String(opts.delay)}`);
  }

  const reason =
    typeof opts.reason === "string" && opts.reason.trim() ? opts.reason.trim() : undefined;
  const inGateway = process.env.OPENCLAW_IN_GATEWAY === "1";
  const mode: "soft" | "hard" = opts.hard
    ? "hard"
    : opts.soft
      ? "soft"
      : inGateway
        ? "soft"
        : "hard";

  const rpcParams: {
    mode: "soft" | "hard";
    delayMs?: number;
    reason?: string;
  } = {
    mode,
    reason,
  };
  if (typeof delayMs === "number" && Number.isFinite(delayMs)) {
    rpcParams.delayMs = delayMs;
  }

  try {
    const rpcRes = await callGateway<{
      ok?: boolean;
      mode?: "soft" | "hard";
      delayMs?: number;
      reason?: string;
    }>({
      method: "gateway.restart",
      params: rpcParams,
      timeoutMs: 10_000,
    });

    printRpcRestartScheduled(opts, {
      mode: rpcRes.mode === "hard" ? "hard" : mode,
      delayMs:
        typeof rpcRes.delayMs === "number" && Number.isFinite(rpcRes.delayMs)
          ? Math.max(0, Math.floor(rpcRes.delayMs))
          : (delayMs ?? DEFAULT_RESTART_DELAY_MS),
      reason: rpcRes.reason ?? reason,
    });
    return true;
  } catch (err) {
    if (inGateway && !opts.hard) {
      failRestart(
        opts,
        `Gateway soft restart RPC failed: ${String(err)}. Avoid hard restarts from inside the gateway process.`,
      );
    }

    if (!opts.json) {
      defaultRuntime.log(
        `Gateway RPC restart failed (${String(err)}); falling back to service restart.`,
      );
    }

    return await runServiceRestart({
      serviceNoun: "Gateway",
      service: resolveGatewayService(),
      renderStartHints: renderGatewayServiceStartHints,
      opts,
    });
  }
}
