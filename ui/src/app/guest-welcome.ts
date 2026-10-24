import { gatewayOriginScope } from "@openclaw/gateway-client/browser";
import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import type { GatewayBrowserClient } from "../api/gateway.ts";
import { isGatewayMethodAdvertised } from "../lib/gateway-methods.ts";
import { getSafeLocalStorage } from "../local-storage.ts";
import {
  GUEST_WELCOME_ENSURE_METHOD,
  type GuestWelcomeOptions,
  type GuestWelcomePresentation,
} from "./guest-welcome-handle.ts";
import { isRestrictedSessionGuest } from "./operator-access.ts";

type GuestWelcomeEnsureResult =
  | { status: "not_applicable" }
  | { status: "pending"; retryAfterMs: number }
  | { status: "ready"; sessionKey: string; agentId: string; created: boolean }
  | { status: "failed"; message: string };

const POLL_MIN_MS = 500;
const POLL_MAX_MS = 5_000;
/** Setup still pending after this long becomes a retryable failure. */
export const GUEST_WELCOME_PENDING_LIMIT_MS = 3 * 60_000;
const VISITED_KEY_PREFIX = "openclaw.guestWelcome.visited.v1:";

function parseEnsureResult(value: unknown): GuestWelcomeEnsureResult | null {
  const result = asOptionalRecord(value);
  if (!result) {
    return null;
  }
  switch (result.status) {
    case "not_applicable":
      return { status: "not_applicable" };
    case "pending":
      return {
        status: "pending",
        retryAfterMs:
          typeof result.retryAfterMs === "number" && Number.isFinite(result.retryAfterMs)
            ? result.retryAfterMs
            : POLL_MIN_MS,
      };
    case "ready":
      return typeof result.sessionKey === "string" &&
        result.sessionKey.trim() &&
        typeof result.agentId === "string" &&
        result.agentId.trim()
        ? {
            status: "ready",
            sessionKey: result.sessionKey,
            agentId: result.agentId,
            created: result.created === true,
          }
        : null;
    case "failed":
      return {
        status: "failed",
        message: typeof result.message === "string" ? result.message.trim() : "",
      };
    default:
      return null;
  }
}

/**
 * Asks Visitor Access for the signed-in guest's welcome session after connect.
 * The plugin owns creation and idempotency; this owner polls, presents progress,
 * and lands a guest from Home on the session at most once per browser.
 */
export class GuestWelcome {
  private current: GuestWelcomePresentation = { kind: "hidden" };
  private readonly listeners = new Set<() => void>();
  private scope: string | null = null;
  private client: GatewayBrowserClient | null = null;
  private epoch = 0;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private pendingSince: number | null = null;
  /** Ready or not applicable: nothing more to ask in this scope. */
  private settled = false;

  constructor(private readonly options: GuestWelcomeOptions) {}

  get presentation(): GuestWelcomePresentation {
    return this.current;
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  start(): () => void {
    const stop = this.options.gateway.subscribe(() => this.synchronize());
    this.synchronize();
    return () => {
      stop();
      this.cancel();
      this.client = null;
    };
  }

  /** Try again after a failure; shows progress at once while the call runs. */
  retry(): void {
    if (!this.client || this.current.kind !== "failed") {
      return;
    }
    this.pendingSince = null;
    this.publish({ kind: "pending" });
    void this.ensure();
  }

  private publish(next: GuestWelcomePresentation): void {
    const previous = this.current;
    if (
      previous.kind === next.kind &&
      (previous.kind !== "failed" || next.kind !== "failed" || previous.message === next.message)
    ) {
      return;
    }
    this.current = next;
    for (const listener of this.listeners) {
      listener();
    }
  }

  private cancel(): void {
    this.epoch += 1;
    if (this.timer !== undefined) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
  }

  private synchronize(): void {
    const { gateway } = this.options;
    const snapshot = gateway.snapshot;
    if (snapshot.phase !== "connected" || !snapshot.client) {
      // A dropped connection abandons its call and poll; the next client asks again.
      if (this.client) {
        this.client = null;
        this.cancel();
      }
      return;
    }
    const scope =
      gatewayOriginScope(gateway.connection.gatewayUrl) + "\n" + (snapshot.selfUser?.id ?? "");
    if (scope !== this.scope) {
      this.cancel();
      this.scope = scope;
      this.client = null;
      this.settled = false;
      this.pendingSince = null;
      this.publish({ kind: "hidden" });
    }
    if (snapshot.client === this.client) {
      return;
    }
    this.client = snapshot.client;
    // Plugin off, older Gateway, or a non-guest caller: change nothing.
    if (
      isGatewayMethodAdvertised(snapshot, GUEST_WELCOME_ENSURE_METHOD) !== true ||
      !isRestrictedSessionGuest(snapshot.hello?.auth ?? null)
    ) {
      this.publish({ kind: "hidden" });
      return;
    }
    if (!this.settled) {
      void this.ensure();
    }
  }

  private fail(message: string | null): void {
    this.pendingSince = null;
    this.publish({ kind: "failed", message });
  }

  private async ensure(): Promise<void> {
    const client = this.client;
    if (!client) {
      return;
    }
    this.cancel();
    const epoch = this.epoch;
    let result: GuestWelcomeEnsureResult | null;
    try {
      result = parseEnsureResult(await client.request(GUEST_WELCOME_ENSURE_METHOD, {}));
    } catch {
      // A dropped connection retries on the next client instead.
      if (epoch === this.epoch && this.options.gateway.snapshot.client === client) {
        this.fail(null);
      }
      return;
    }
    if (epoch !== this.epoch) {
      return;
    }
    if (!result) {
      this.fail(null);
      return;
    }
    switch (result.status) {
      case "not_applicable":
        this.settled = true;
        this.publish({ kind: "hidden" });
        return;
      case "pending": {
        const now = Date.now();
        this.pendingSince ??= now;
        if (now - this.pendingSince >= GUEST_WELCOME_PENDING_LIMIT_MS) {
          this.fail(null);
          return;
        }
        this.publish({ kind: "pending" });
        this.timer = setTimeout(
          () => {
            this.timer = undefined;
            void this.ensure();
          },
          Math.min(POLL_MAX_MS, Math.max(POLL_MIN_MS, result.retryAfterMs)),
        );
        return;
      }
      case "failed":
        this.fail(result.message || null);
        return;
      case "ready":
        this.settled = true;
        this.pendingSince = null;
        this.publish({ kind: "hidden" });
        await this.land(result, epoch);
    }
  }

  private async land(
    result: Extract<GuestWelcomeEnsureResult, { status: "ready" }>,
    epoch: number,
  ): Promise<void> {
    const key =
      VISITED_KEY_PREFIX +
      gatewayOriginScope(this.options.gateway.connection.gatewayUrl) +
      ":" +
      encodeURIComponent(result.sessionKey);
    try {
      if (getSafeLocalStorage()?.getItem(key) === "1") {
        return;
      }
    } catch {
      // Unreadable storage cannot prove a visit; the write below decides.
    }
    let home = false;
    try {
      home = await this.options.isHomeLanding();
    } catch {
      // An unresolved landing never redirects.
    }
    if (!home || epoch !== this.epoch) {
      return;
    }
    let recorded = false;
    try {
      const storage = getSafeLocalStorage();
      storage?.setItem(key, "1");
      recorded = storage !== null;
    } catch {
      // Blocked or full storage leaves no record.
    }
    // Without a durable record, only the call that created the session lands the guest.
    if (!recorded && !result.created) {
      return;
    }
    this.options.openSession(result.sessionKey, result.agentId);
  }
}
