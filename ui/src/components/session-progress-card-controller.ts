import type { ProgressCard, ProgressCardGetParams } from "@openclaw/gateway-protocol";
import type { ReactiveController, ReactiveControllerHost } from "lit";
import type { ApplicationGateway } from "../app/gateway.ts";
import {
  sessionProgressCardsForGateway,
  type SessionProgressCardStore,
} from "../lib/session-progress-cards.ts";

type SessionProgressCardControllerOptions = {
  gateway: () => ApplicationGateway | null | undefined;
  target: () => ProgressCardGetParams | null | undefined;
};

/** Keeps one view on the gateway-scoped durable progress-card snapshot. */
export class SessionProgressCardController implements ReactiveController {
  private connected = false;
  private store: SessionProgressCardStore | null = null;
  private stopUpdates: (() => void) | null = null;
  private target: ProgressCardGetParams | undefined;
  private client: ApplicationGateway["snapshot"]["client"] = null;
  private hello: ApplicationGateway["snapshot"]["hello"] = null;

  constructor(
    private readonly host: ReactiveControllerHost,
    private readonly options: SessionProgressCardControllerOptions,
  ) {
    host.addController(this);
  }

  get card(): ProgressCard | null {
    return this.target ? (this.store?.get(this.target) ?? null) : null;
  }

  get loading(): boolean {
    return !this.target || this.store?.get(this.target) === undefined;
  }

  retry = (): void => {
    if (this.target?.sessionKey) {
      void this.store?.load(this.target).catch(() => undefined);
    }
  };

  get error() {
    return this.target ? this.store?.getError(this.target) : undefined;
  }

  dismiss = (card: ProgressCard): Promise<boolean> =>
    this.target
      ? (this.store?.dismiss(this.target, card) ?? Promise.resolve(false))
      : Promise.resolve(false);

  hostConnected(): void {
    this.connected = true;
    this.synchronize();
  }

  hostUpdate(): void {
    // A queued Lit update can run after disconnect; do not reacquire the released store.
    if (this.connected) {
      this.synchronize();
    }
  }

  hostDisconnected(): void {
    this.connected = false;
    this.release();
  }

  private synchronize(): void {
    const gateway = this.options.gateway() ?? null;
    const target = this.options.target() ?? undefined;
    const client = gateway?.snapshot.client ?? null;
    const hello = gateway?.snapshot.hello ?? null;
    const nextStore = gateway ? sessionProgressCardsForGateway(gateway) : null;
    if (nextStore !== this.store) {
      this.release();
      this.store = nextStore;
      this.stopUpdates = nextStore?.subscribe(() => this.host.requestUpdate()) ?? null;
    }
    if (
      target?.sessionKey === this.target?.sessionKey &&
      target?.agentId === this.target?.agentId &&
      (!target || (client === this.client && hello === this.hello))
    ) {
      return;
    }
    this.target = target;
    this.client = client;
    this.hello = hello;
    this.store?.watch(this, target ? [target] : [], {
      admitAutomaticRead: () => {
        const currentTarget = this.options.target();
        return (
          this.connected &&
          this.options.gateway() === gateway &&
          gateway?.snapshot.client === client &&
          gateway?.snapshot.hello === hello &&
          currentTarget?.sessionKey === target?.sessionKey &&
          currentTarget?.agentId === target?.agentId
        );
      },
    });
  }

  private release(): void {
    this.store?.unwatch(this);
    this.stopUpdates?.();
    this.stopUpdates = null;
    this.store = null;
    this.target = undefined;
    this.client = null;
    this.hello = null;
  }
}
