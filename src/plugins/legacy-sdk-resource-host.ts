import { AsyncLocalStorage } from "node:async_hooks";
import { AsyncWorkScope } from "../shared/async-work-scope.js";
import { createDeferredCore } from "../shared/deferred.js";
import { resolveGlobalSingleton } from "../shared/global-singleton.js";
import {
  getCanonicalGatewayContextResolver,
  getPluginRuntimeGatewayRequestScope,
} from "./runtime/gateway-request-scope.js";

type ResourceClaim = { release: () => Promise<void> };

/** Owns resources borrowed by shipped SDK results that have no release method. */
export class LegacyPluginSdkResourceHost {
  private readonly work = new AsyncWorkScope();
  private readonly claims = new Map<object, ResourceClaim>();
  private readonly pending = new Set<Promise<void>>();
  private readonly failures: unknown[] = [];
  private closing?: Promise<void>;

  assertOpen(): void {
    if (this.closing) {
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

  adopt(source: object, claim: ResourceClaim): void {
    this.assertOpen();
    if (this.claims.has(source)) {
      this.releaseClaim(claim);
    } else {
      this.claims.set(source, claim);
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
      operation.resolve(claim.release());
    } catch (error) {
      operation.reject(error);
    }
  }

  close(): Promise<void> {
    if (!this.closing) {
      // A projection getter can close this host before its temporary claim is adopted.
      this.closing = Promise.resolve().then(async () => {
        await this.work.drain();
        const claims = [...this.claims.values()];
        this.claims.clear();
        for (const claim of claims) {
          this.releaseClaim(claim);
        }
        while (this.pending.size > 0) {
          await Promise.all(this.pending);
        }
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

/** Associate exact host resolvers without calling them after their authority closes. */
export function bindLegacyPluginSdkResourceHost(
  resolver: object,
  host: LegacyPluginSdkResourceHost,
): void {
  gatewayHosts.set(resolver, host);
}

function getBoundLegacyPluginSdkResourceHost(): LegacyPluginSdkResourceHost | undefined {
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
  return hostContext.getStore();
}

/** Standalone callers of the shipped bare-result SDK retain their process lifetime. */
export function getLegacyPluginSdkResourceHost(): LegacyPluginSdkResourceHost {
  return (
    getBoundLegacyPluginSdkResourceHost() ??
    resolveGlobalSingleton(
      Symbol.for("openclaw.legacyPluginSdkStandaloneResourceHost"),
      () => new LegacyPluginSdkResourceHost(),
    )
  );
}
