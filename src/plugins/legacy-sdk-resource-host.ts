import { AsyncLocalStorage } from "node:async_hooks";
import type { GatewayScheduler } from "../infra/gateway-scheduler.js";
import { AsyncWorkScope, getAsyncWorkSignal } from "../shared/async-work-scope.js";
import { createDeferredCore } from "../shared/deferred.js";
import { resolveGlobalSingleton } from "../shared/global-singleton.js";
import type { PluginInstanceHandle } from "./plugin-instance-scope.js";
import { resolvePluginReturnPromise } from "./plugin-return-value.js";
import { hasRetainedPluginRuntimeCloseError } from "./runtime-close-error.js";
import {
  getCanonicalGatewayContextResolver,
  getPluginRuntimeGatewayRequestScope,
} from "./runtime/gateway-request-scope.js";

type ResourceClaim = { release: () => Promise<void> };

export type LegacyPluginSdkProviderProjection = {
  retain(physical: ResourceClaim): ResourceClaim;
  project<T>(provider: T, instance: PluginInstanceHandle | undefined): T;
};

/** Owns resources borrowed by shipped SDK results that have no release method. */
export class LegacyPluginSdkResourceHost {
  private readonly work = new AsyncWorkScope();
  private readonly claims = new Map<object, ResourceClaim>();
  private readonly providerProjections = new WeakMap<object, LegacyPluginSdkProviderProjection>();
  private readonly pending = new Set<Promise<void>>();
  private readonly failures: unknown[] = [];
  private closing?: Promise<void>;
  private gatewayScheduler?: GatewayScheduler;

  get scheduler(): GatewayScheduler {
    this.assertOpen();
    if (!this.gatewayScheduler) {
      throw new Error("Plugin SDK resource host has no Gateway scheduler");
    }
    this.gatewayScheduler.signal.throwIfAborted();
    return this.gatewayScheduler;
  }

  bindScheduler(scheduler: GatewayScheduler): void {
    this.assertOpen();
    scheduler.signal.throwIfAborted();
    if (this.gatewayScheduler && this.gatewayScheduler !== scheduler) {
      throw new Error("Plugin SDK resource host already belongs to another Gateway scheduler");
    }
    this.gatewayScheduler = scheduler;
  }

  assertOpen(): void {
    if (this.closing || this.work.isClosing) {
      throw new Error("Plugin SDK resource host is closed");
    }
  }

  run<T>(run: () => T): T {
    return hostContext.run(this, run);
  }

  track<T>(run: () => T | Promise<T>): Promise<T> {
    this.assertOpen();
    return this.work.track(() => this.run(run));
  }

  /** Preserve synchronous SDK hooks while joining their asynchronous results and descendants. */
  invoke<T>(run: () => T): T {
    if (getAsyncWorkSignal() !== this.work.signal) {
      this.assertOpen();
    }
    return this.work.run(() =>
      this.run(() => {
        const result = run();
        const completion = resolvePluginReturnPromise(result);
        // SAFETY: Only promise-like results are normalized; synchronous hook values stay unchanged.
        return completion ? (this.work.track(() => completion) as T) : result;
      }),
    );
  }

  adopt(source: object, claim: ResourceClaim): void {
    this.assertOpen();
    if (this.claims.has(source)) {
      this.releaseClaim(claim);
    } else {
      this.claims.set(source, claim);
    }
  }

  /** View lookup shares identity; only adopted or temporary claims own disposal. */
  getProviderProjection(
    source: object,
    create: () => LegacyPluginSdkProviderProjection,
  ): LegacyPluginSdkProviderProjection {
    this.assertOpen();
    let projection = this.providerProjections.get(source);
    if (!projection) {
      projection = create();
      this.providerProjections.set(source, projection);
    }
    return projection;
  }

  forgetProviderProjection(source: object, projection: LegacyPluginSdkProviderProjection): void {
    if (this.providerProjections.get(source) === projection) {
      this.providerProjections.delete(source);
    }
  }

  /** Projection failures still own their asynchronous release until it settles. */
  releaseClaim(claim: ResourceClaim): void {
    const operation = createDeferredCore();
    const completion = operation.promise.then(
      () => {
        this.pending.delete(completion);
      },
      (error: unknown) => {
        this.failures.push(error);
        this.pending.delete(completion);
      },
    );
    // Register before release can reenter host close through a disposer.
    this.pending.add(completion);
    try {
      // Failed projections may leave admitted tails; an idle host still releases immediately.
      operation.resolve(
        this.work.hasPendingWork
          ? AsyncWorkScope.runWhenAllIdle(
              () => [this.work],
              () => claim.release(),
            )
          : claim.release(),
      );
    } catch (error) {
      operation.reject(error);
    }
  }

  /** Fence new SDK work and join its tails before prepared resources can retire. */
  async drainWork(): Promise<void> {
    await this.work.drain();
    await this.drainPendingReleases();
    // Ordinary release errors are reported by close; failed prerequisites still own resources.
    if (this.failures.some(hasRetainedPluginRuntimeCloseError)) {
      throw new AggregateError(this.failures, "Plugin SDK resources could not all be disposed");
    }
  }

  private async drainPendingReleases(): Promise<void> {
    while (this.pending.size > 0) {
      await Promise.all(this.pending);
    }
  }

  close(): Promise<void> {
    if (!this.closing) {
      // A projection getter can close this host before its temporary claim is adopted.
      this.closing = Promise.resolve().then(async () => {
        await this.drainWork();
        const claims = [...this.claims.values()];
        this.claims.clear();
        for (const claim of claims) {
          this.releaseClaim(claim);
        }
        await this.drainPendingReleases();
        if (this.failures.length > 0) {
          throw new AggregateError(this.failures, "Plugin SDK resources could not all be disposed");
        }
      });
    }
    return this.closing;
  }
}

const { hostContext, gatewayHosts } = resolveGlobalSingleton(
  Symbol.for("openclaw.legacyPluginSdkResourceHosts"),
  () => ({
    hostContext: new AsyncLocalStorage<LegacyPluginSdkResourceHost>(),
    gatewayHosts: new WeakMap<object, LegacyPluginSdkResourceHost>(),
  }),
);
const STANDALONE_HOST_KEY = Symbol.for("openclaw.legacyPluginSdkStandaloneResourceHost");

/** Associate exact host resolvers without calling them after their authority closes. */
export function bindLegacyPluginSdkResourceHost(
  resolver: object,
  host: LegacyPluginSdkResourceHost,
): void {
  gatewayHosts.set(resolver, host);
}

export function getBoundLegacyPluginSdkResourceHost(): LegacyPluginSdkResourceHost | undefined {
  const scope = getPluginRuntimeGatewayRequestScope();
  const resolver = scope?.resolveGatewayContext ?? scope?.context?.resolveGatewayContext;
  if (resolver) {
    const owner = getCanonicalGatewayContextResolver(resolver);
    const host = owner ? gatewayHosts.get(owner) : undefined;
    if (!host) {
      throw new Error("Gateway SDK resource host is not bound");
    }
    return host;
  }
  const host = hostContext.getStore();
  // Process-retained SDK results are not a command or Gateway scheduling owner.
  // SAFETY: The singleton slot is read as unknown and compared only by identity.
  const standaloneHost = (globalThis as Record<PropertyKey, unknown>)[STANDALONE_HOST_KEY];
  return host === standaloneHost ? undefined : host;
}

/** Standalone callers of the shipped bare-result SDK retain their process lifetime. */
export function getLegacyPluginSdkResourceHost(): LegacyPluginSdkResourceHost {
  return (
    getBoundLegacyPluginSdkResourceHost() ??
    resolveGlobalSingleton(STANDALONE_HOST_KEY, () => new LegacyPluginSdkResourceHost())
  );
}
