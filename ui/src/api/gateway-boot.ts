import {
  getGatewaySessionMessageSubscriptionCoordinator,
  releaseGatewaySessionMessageSubscription,
  resetGatewaySessionMessageSubscriptionCoordinator,
  type GatewaySessionMessageSubscription,
  type GatewaySessionMessageSubscriptionOptions,
} from "@openclaw/gateway-client/browser";
import { hasOperatorApprovalsAccess } from "../app/operator-access.ts";
import { areUiSessionKeysEquivalent } from "../lib/sessions/session-key.ts";
import {
  GatewayBrowserClient,
  type GatewayBrowserClientOptions,
  type GatewayEventFrame,
  type GatewayHelloOk,
} from "./gateway.ts";

const MAX_BOOT_EVENTS = 256;
const MAX_BOOT_BYTES = 2 * 1024 * 1024;
const MAX_BOOT_WAIT_MS = 10_000;
const boots = new WeakMap<GatewayBrowserClient, EarlyGateway>();

/** One transport retains delivery until its application and foreground consumer exist. */
export class EarlyGateway {
  readonly client: GatewayBrowserClient;
  private owner: GatewayBrowserClientOptions | undefined;
  private hello: GatewayHelloOk | undefined;
  private closed: Parameters<NonNullable<GatewayBrowserClientOptions["onClose"]>>[0] | undefined;
  private events: GatewayEventFrame[] = [];
  private bytes = 0;
  private active = true;
  private draining = false;
  private subscription: Promise<GatewaySessionMessageSubscription> | undefined;
  private readonly timeout: ReturnType<typeof setTimeout>;

  constructor(
    private readonly options: GatewayBrowserClientOptions,
    private readonly sessionKey: string,
    private readonly history: GatewaySessionMessageSubscriptionOptions["initialHistory"],
    private readonly location: string,
  ) {
    const currentOptions = () => this.owner ?? options;
    this.client = new GatewayBrowserClient({
      ...options,
      get modelCatalog() {
        return currentOptions().modelCatalog;
      },
      get includeSessionMessageBodies() {
        return currentOptions().includeSessionMessageBodies;
      },
      onHello: (hello) => {
        this.closed = undefined;
        if (this.active && !this.retain(hello)) {
          return;
        }
        if (this.active && this.subscription && hasOperatorApprovalsAccess(hello.auth ?? null)) {
          this.subscription = this.subscription.then((subscription) =>
            this.withApprovals(subscription),
          );
          void this.subscription.catch(() => undefined);
        }
        if (this.owner) {
          void this.owner.modelCatalog;
          this.owner.onHello?.(hello);
        } else {
          this.hello = hello;
        }
      },
      onEvent: (event) => {
        if (!this.active) {
          this.owner?.onEvent?.(event);
          return;
        }
        if (this.events.length >= MAX_BOOT_EVENTS) {
          this.fallback();
          return;
        }
        if (!this.retain(event)) {
          return;
        }
        this.events.push(event);
      },
      onClose: (info) => {
        if (this.active && !this.owner && info.error && info.willRetry) {
          // Keep the protocol's retry and its error receipt. Replacing this
          // client would hide admission errors and restart its retry budget.
          this.hello = undefined;
          this.events = [];
          this.bytes = 0;
          this.subscription = undefined;
          resetGatewaySessionMessageSubscriptionCoordinator(this.client);
          if (this.retain(info)) {
            this.closed = info;
          }
          return;
        }
        if (this.active) {
          this.retire();
          if (!this.owner) {
            // Terminal admission failures belong to the login UI; transient
            // failures leave startup free to establish its normal connection.
            if (!info.willRetry) {
              this.closed = info;
            }
            this.client.stop();
          }
        }
        this.owner?.onClose?.(info);
      },
      onRecoveryScopeChange: () => this.owner?.onRecoveryScopeChange?.(),
      onConnecting: () => this.owner?.onConnecting?.(),
      onReconnectScheduled: (delay) => this.owner?.onReconnectScheduled?.(delay),
      onGap: (info) => this.owner?.onGap?.(info),
      onRequestTiming: (timing) => this.owner?.onRequestTiming?.(timing),
    });
    this.timeout = setTimeout(() => this.fallback(), MAX_BOOT_WAIT_MS);
    boots.set(this.client, this);
    this.client.start();
    if (history) {
      this.subscription = this.client.connectSent.then(async (sent) => {
        if (!sent || !this.active) {
          throw new Error("Early Gateway connection retired");
        }
        const subscription = await getGatewaySessionMessageSubscriptionCoordinator(this.client, {
          keysEquivalent: areUiSessionKeysEquivalent,
        }).acquire(sessionKey, { initialHistory: history });
        if (!this.active || !this.retain(subscription)) {
          throw new Error("Early Gateway connection retired");
        }
        return subscription;
      });
      // The foreground owner applies its existing read-retry policy on attach.
      void this.subscription.catch(() => undefined);
    }
  }

  private retain(value: unknown): boolean {
    this.bytes += JSON.stringify(value).length * 2;
    if (this.bytes <= MAX_BOOT_BYTES) {
      return true;
    }
    this.fallback();
    return false;
  }

  adopt(options: GatewayBrowserClientOptions): GatewayBrowserClient | null {
    if (
      (!this.active && !this.closed) ||
      this.owner ||
      globalThis.location?.href !== this.location ||
      (
        [
          "url",
          "token",
          "password",
          "bootstrapToken",
          "bootstrapProfile",
          "nativeConnectAuth",
        ] as const
      ).some((key) => options[key] !== this.options[key])
    ) {
      this.closed = undefined;
      this.fallback();
      return null;
    }
    this.owner = options;
    // The store must install the returned client before any hello callback runs.
    queueMicrotask(() => {
      if (this.closed) {
        const closed = this.closed;
        this.closed = undefined;
        this.owner?.onClose?.(closed);
      } else if (this.active && this.hello) {
        const hello = this.hello;
        this.hello = undefined;
        try {
          void this.owner?.modelCatalog;
          this.owner?.onHello?.(hello);
        } catch (error) {
          console.error("[gateway] hello handler error:", error);
        }
      }
    });
    return this.client;
  }

  async takeSubscription(key: string, options: GatewaySessionMessageSubscriptionOptions) {
    if (!this.active) {
      return null;
    }
    if (globalThis.location?.href !== this.location) {
      this.fallback();
      throw new Error("Early Gateway route changed");
    }
    // Sidebar and subagent observers are independent of the foreground handoff.
    if (key !== this.sessionKey || options.agentId?.trim() || options.mode) {
      return null;
    }
    const pending = this.subscription;
    this.subscription = undefined;
    if (!pending) {
      this.drain();
      return null;
    }
    const historyMatches = JSON.stringify(options.initialHistory) === JSON.stringify(this.history);
    try {
      let subscription = await pending;
      if (!this.active) {
        throw new Error("Early Gateway connection retired");
      }
      if (!historyMatches) {
        // The pane may learn a recovery cursor or pending input during boot.
        // Keep live delivery; its history owner will request the correct snapshot.
        delete subscription.initialHistory;
      }
      if (options.includeApprovals && !subscription.includeApprovals) {
        subscription = await this.withApprovals(subscription);
      }
      return subscription;
    } finally {
      this.drain();
    }
  }

  private async withApprovals(subscription: GatewaySessionMessageSubscription) {
    const upgraded = await getGatewaySessionMessageSubscriptionCoordinator(this.client, {
      keysEquivalent: areUiSessionKeysEquivalent,
    }).acquire(this.sessionKey, { includeApprovals: true });
    if (
      !this.active ||
      (upgraded.approvalReplay !== undefined && !this.retain(upgraded.approvalReplay))
    ) {
      throw new Error("Early Gateway connection retired");
    }
    upgraded.initialHistory = subscription.initialHistory;
    await releaseGatewaySessionMessageSubscription(subscription);
    return upgraded;
  }

  private drain() {
    if (this.draining) {
      return;
    }
    this.draining = true;
    // A microtask checkpoint between events preserves promise continuations, just
    // as separate WebSocket tasks do. Arrivals join this FIFO until it is empty.
    const next = () => {
      if (!this.active) {
        return;
      }
      const event = this.events.shift();
      if (event) {
        try {
          this.owner?.onEvent?.(event);
        } catch (error) {
          console.error("[gateway] event handler error:", error);
        }
        queueMicrotask(next);
      } else {
        this.active = false;
        clearTimeout(this.timeout);
        this.bytes = 0;
        boots.delete(this.client);
      }
    };
    queueMicrotask(next);
  }

  private fallback() {
    if (!this.active) {
      return;
    }
    this.retire();
    if (this.owner) {
      this.client.forceReconnect("early Gateway handoff retired");
    } else {
      this.client.stop();
    }
  }

  private retire() {
    this.active = false;
    this.hello = undefined;
    this.closed = undefined;
    this.events = [];
    this.bytes = 0;
    this.subscription = undefined;
    clearTimeout(this.timeout);
    boots.delete(this.client);
    resetGatewaySessionMessageSubscriptionCoordinator(this.client);
  }
}

export function takeEarlyGatewaySubscription(
  client: GatewayBrowserClient,
  key: string,
  options: GatewaySessionMessageSubscriptionOptions,
): Promise<GatewaySessionMessageSubscription | null> | undefined {
  return boots.get(client)?.takeSubscription(key, options);
}
