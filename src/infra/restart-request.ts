import type { GatewayRestartIntent } from "./restart-intent.js";

export type RestartDeferralHooks = {
  onDeferring?: (pending: number) => void;
  onStillPending?: (pending: number, elapsedMs: number) => void;
  onReady?: () => void;
  onTimeout?: (pending: number | undefined, elapsedMs: number) => void;
  onCheckError?: (err: unknown) => void;
};

export type RestartDeferralHandle = { cancel: () => void };

export type GatewayRestartEmitter = (
  reasonOverride?: string,
  intent?: GatewayRestartIntent,
) => GatewayRestartEmitResult;

export type GatewayRestartEmitResult =
  | { status: "emitted" }
  | { status: "coalesced" }
  | { status: "failed" };

export type RestartAuditInfo = {
  actor?: string;
  deviceId?: string;
  clientIp?: string;
  changedPaths?: string[];
};

function summarizeChangedPaths(paths: string[] | undefined, maxPaths = 6): string | null {
  if (!Array.isArray(paths) || paths.length === 0) {
    return null;
  }
  if (paths.length <= maxPaths) {
    return paths.join(",");
  }
  const head = paths.slice(0, maxPaths).join(",");
  return `${head},+${paths.length - maxPaths} more`;
}

export function formatRestartAudit(audit: RestartAuditInfo | undefined): string {
  const actor = typeof audit?.actor === "string" && audit.actor.trim() ? audit.actor.trim() : null;
  const deviceId =
    typeof audit?.deviceId === "string" && audit.deviceId.trim() ? audit.deviceId.trim() : null;
  const clientIp =
    typeof audit?.clientIp === "string" && audit.clientIp.trim() ? audit.clientIp.trim() : null;
  const changed = summarizeChangedPaths(audit?.changedPaths);
  const fields = [
    actor && `actor=${actor}`,
    deviceId && `device=${deviceId}`,
    clientIp && `ip=${clientIp}`,
    changed && `changedPaths=${changed}`,
  ].filter(Boolean);
  return fields.length > 0 ? fields.join(" ") : "actor=<unknown>";
}

export type ScheduledRestart = {
  ok: boolean;
  pid: number;
  signal: "SIGUSR2";
  delayMs: number;
  reason?: string;
  mode: "emit" | "signal" | "supervisor";
  coalesced: boolean;
  cooldownMsApplied: number;
  // Only one session owns acknowledgement hooks, independently of coalesced request authority.
  emitHooksQueued: boolean;
};

export function normalizeGatewayRestartDelayMs(delayMs?: number): number {
  return typeof delayMs === "number" && Number.isFinite(delayMs)
    ? Math.min(Math.max(Math.floor(delayMs), 0), 60_000)
    : 2000;
}

export type RestartEmitHooks = {
  assertCurrent?: () => void;
  beforeEmit?: () => Promise<void>;
  afterEmitRejected?: () => Promise<void>;
  afterEmitFailed?: () => Promise<void>;
  emitRestart?: GatewayRestartEmitter;
};

/** Captures one admitted requester independently of best-effort restart preparation. */
export class GatewayRestartRequest {
  readonly #assertCurrent: (() => void) | undefined;
  #revoked = false;

  constructor(readonly hooks?: RestartEmitHooks) {
    this.#assertCurrent = hooks?.assertCurrent;
  }

  isCurrent(): boolean {
    if (this.#revoked) {
      return false;
    }
    try {
      this.#assertCurrent?.();
      return true;
    } catch {
      this.#revoked = true;
      return false;
    }
  }
}

/** One scheduled cycle retains all accepted requests but only one session's acknowledgement. */
export class PendingGatewayRestart {
  readonly #requests: GatewayRestartRequest[] = [];
  emitHooks: GatewayRestartRequest | undefined;
  sessionKey: string | undefined;

  admit(hooks: RestartEmitHooks | undefined): GatewayRestartRequest {
    const request = new GatewayRestartRequest(hooks);
    this.#requests.push(request);
    return request;
  }

  isCurrent(): boolean {
    return this.#requests.some((request) => request.isCurrent());
  }

  takeEmitHooks(): GatewayRestartRequest | undefined {
    const request = this.emitHooks;
    this.emitHooks = undefined;
    return request;
  }
}
