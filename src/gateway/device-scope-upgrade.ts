import type { ScopeUpgradeResult } from "../../packages/gateway-protocol/src/index.js";
import { racePromiseWithAbortSignal } from "../infra/abort-signal.js";
import { getPairedDevice, getPendingDevicePairing } from "../infra/device-pairing.js";
import type { GatewayScheduler, GatewaySchedulerScope } from "../infra/gateway-scheduler.js";
import { AsyncWorkScope, getAsyncWorkSignal, trackAsyncWork } from "../shared/async-work-scope.js";
import { createDeferredCore, type Deferred } from "../shared/deferred.js";
import { roleScopesAllow } from "../shared/operator-scope-compat.js";

const TERMINAL_GRACE_MS = 15_000;
const DURABLE_RECONCILE_INTERVAL_MS = 250;

type UpgradeOwner = {
  deviceId: string;
  publicKey: string;
};

type UpgradeEntry = {
  requestId: string;
  owner: UpgradeOwner;
  requestedScopes: string[];
  initialToken?: string;
  initialApprovedAtMs?: number;
  expiresAtMs: number;
  resolutionHint?: "approved" | "rejected";
  resultPromise?: Promise<ScopeUpgradeResult | null>;
  wake: Deferred;
};

function sameOwner(left: UpgradeOwner, right: UpgradeOwner): boolean {
  return left.deviceId === right.deviceId && left.publicKey === right.publicKey;
}

/** Coordinates live device scope-upgrade waiters with the durable pairing store. */
export class ScopeUpgradeCoordinator {
  private readonly entries = new Map<string, UpgradeEntry>();
  private readonly work = new AsyncWorkScope();
  private readonly scheduler: GatewaySchedulerScope;
  private lifetimeBound = false;

  constructor(scheduler: GatewayScheduler) {
    this.scheduler = scheduler.scope();
  }

  private bindGatewayLifetime(): void {
    if (this.lifetimeBound || this.work.isClosing) {
      return;
    }
    this.lifetimeBound = true;
    // Construction is outside received work. The first registration captures
    // this Gateway, never a later waiter or an ordinary socket disconnect.
    const gatewaySignal = getAsyncWorkSignal();
    if (!gatewaySignal) {
      return;
    }
    if (gatewaySignal.aborted) {
      void this.close();
      return;
    }
    const signal = AbortSignal.any([gatewaySignal, this.work.signal]);
    void trackAsyncWork(
      () =>
        new Promise<void>((resolve, reject) => {
          // Fence synchronously: a previously queued poll wake must see close before
          // its microtask can start another read. The lifetime task joins the drain.
          signal.addEventListener(
            "abort",
            () => {
              void this.close().then(resolve, reject);
            },
            { once: true },
          );
        }),
    );
  }

  async close(): Promise<void> {
    this.work.beginClose();
    this.scheduler.beginClose();
    for (const entry of this.entries.values()) {
      entry.wake.resolve();
    }
    this.entries.clear();
    await this.work.drain();
  }

  register(params: {
    requestId: string;
    expiresAtMs: number;
    owner: UpgradeOwner;
    requestedScopes: string[];
    initialToken?: string;
    initialApprovedAtMs?: number;
  }): boolean {
    this.bindGatewayLifetime();
    if (this.work.isClosing) {
      return false;
    }
    const existing = this.entries.get(params.requestId);
    if (existing && !sameOwner(existing.owner, params.owner)) {
      return false;
    }
    const entry: UpgradeEntry = existing ?? {
      requestId: params.requestId,
      owner: params.owner,
      requestedScopes: [...params.requestedScopes],
      initialToken: params.initialToken,
      initialApprovedAtMs: params.initialApprovedAtMs,
      expiresAtMs: 0,
      wake: createDeferredCore(),
    };
    entry.requestedScopes = [...params.requestedScopes];
    entry.expiresAtMs = params.expiresAtMs;
    this.scheduleCleanup(
      entry,
      Math.max(0, entry.expiresAtMs + TERMINAL_GRACE_MS - this.scheduler.now()),
    );
    this.entries.set(entry.requestId, entry);
    return true;
  }

  notify(requestId: string, resolution: "approved" | "rejected"): void {
    const entry = this.entries.get(requestId);
    if (!entry) {
      return;
    }
    entry.resolutionHint = resolution;
    const wake = entry.wake;
    entry.wake = createDeferredCore();
    wake.resolve();
  }

  async wait(requestId: string, owner: UpgradeOwner): Promise<ScopeUpgradeResult | null> {
    const entry = this.entries.get(requestId);
    if (!entry || !sameOwner(entry.owner, owner)) {
      return null;
    }
    if (!entry.resultPromise) {
      const pending = this.work.track(() => this.waitForResult(entry));
      entry.resultPromise = pending;
      void pending.catch(() => {
        if (entry.resultPromise === pending) {
          entry.resultPromise = undefined;
        }
      });
    }
    return await racePromiseWithAbortSignal(entry.resultPromise, getAsyncWorkSignal());
  }

  private async waitForResult(entry: UpgradeEntry): Promise<ScopeUpgradeResult | null> {
    while (!this.work.isClosing) {
      if (this.scheduler.now() >= entry.expiresAtMs) {
        this.scheduleCleanup(entry);
        return { status: "expired", requestId: entry.requestId };
      }
      const wake = entry.wake;
      const result = await this.readDurableResult(entry);
      if (this.work.isClosing) {
        break;
      }
      if (result) {
        this.scheduleCleanup(entry);
        return result;
      }
      const delayMs = Math.min(
        DURABLE_RECONCILE_INTERVAL_MS,
        Math.max(0, entry.expiresAtMs - this.scheduler.now()),
      );
      const timer = setTimeout(wake.resolve, delayMs);
      timer.unref();
      try {
        await wake.promise;
      } finally {
        // A durable notification or close also owns cancellation of the losing timer.
        clearTimeout(timer);
        if (entry.wake === wake) {
          entry.wake = createDeferredCore();
        }
      }
    }
    return null;
  }

  private async readDurableResult(entry: UpgradeEntry): Promise<ScopeUpgradeResult | null> {
    const pending = await getPendingDevicePairing(entry.requestId);
    if (this.work.isClosing || pending) {
      return null;
    }
    if (entry.resolutionHint === "rejected") {
      return { status: "rejected", requestId: entry.requestId };
    }
    const paired = await getPairedDevice(entry.owner.deviceId);
    if (this.work.isClosing) {
      return null;
    }
    const token = paired?.tokens?.operator;
    const approvedEvidence =
      entry.resolutionHint === "approved" ||
      (token?.token !== entry.initialToken && paired?.approvedAtMs !== entry.initialApprovedAtMs);
    const approved =
      paired?.publicKey === entry.owner.publicKey &&
      token !== undefined &&
      token.revokedAtMs === undefined &&
      approvedEvidence &&
      roleScopesAllow({
        role: "operator",
        requestedScopes: entry.requestedScopes,
        allowedScopes: token.scopes,
      });
    return approved
      ? {
          status: "approved",
          requestId: entry.requestId,
          deviceToken: token.token,
          scopes: token.scopes,
        }
      : { status: "rejected", requestId: entry.requestId };
  }

  private scheduleCleanup(entry: UpgradeEntry, delayMs = TERMINAL_GRACE_MS): void {
    this.scheduler.schedule({
      id: `device-scope-upgrade:${entry.requestId}`,
      delayMs,
      run: () => {
        this.entries.delete(entry.requestId);
      },
    });
  }
}
