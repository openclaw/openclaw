import { AsyncLocalStorage } from "node:async_hooks";
import { sanitizeForLog } from "../../packages/terminal-core/src/ansi.js";
import type { ContextEngineRegistration } from "../plugins/registry-contribution-types.js";
import {
  getPluginRegistryInspectionResources,
  type PluginRegistryInspectionResources,
} from "../plugins/registry-inspection-resources.js";
import type { PluginRegistry } from "../plugins/registry-types.js";
import {
  AsyncWorkScope,
  captureAsyncWorkTracker,
  getAsyncWorkSignal,
} from "../shared/async-work-scope.js";
import { createDeferredCore } from "../shared/deferred.js";
import { resolveGlobalSingleton } from "../shared/global-singleton.js";
import type { ContextEngine } from "./types.js";

// Adoption copies entries by identity; the copied view's primary source is not their owner.
const registrationSources = resolveGlobalSingleton(
  Symbol.for("openclaw.contextEngineRegistrationSources"),
  () => new WeakMap<ContextEngineRegistration, PluginRegistryInspectionResources>(),
);

export function recordContextEngineRegistrationSource(
  registration: ContextEngineRegistration,
  registry: PluginRegistry,
): void {
  const resources = getPluginRegistryInspectionResources(registry);
  if (resources) {
    registrationSources.set(registration, resources);
  }
}

export class ContextEngineFactoryResources {
  readonly work = new AsyncWorkScope();
  readonly context = this.work.run(() => AsyncLocalStorage.snapshot());
  readonly cleanupWork = new AsyncWorkScope();
  readonly cleanupContext = this.cleanupWork.run(() => AsyncLocalStorage.snapshot());
  private readonly parentSignal = getAsyncWorkSignal();
  private readonly abort = () => {
    this.context(() => this.work.beginClose(this.parentSignal?.reason));
    this.cleanupContext(() => this.cleanupWork.beginClose(this.parentSignal?.reason));
  };

  constructor(private readonly claim: { release: () => Promise<void> }) {
    this.parentSignal?.addEventListener("abort", this.abort, { once: true });
    if (this.parentSignal?.aborted) {
      this.abort();
    }
  }

  run<T>(operation: () => T | Promise<T>): Promise<T> {
    return this.work.track(() => this.context(operation));
  }

  runCleanup<T>(operation: () => T): T {
    try {
      return this.cleanupWork.run(() => this.cleanupContext(operation));
    } finally {
      this.context(() => this.work.beginClose());
    }
  }

  release(): Promise<void> {
    this.parentSignal?.removeEventListener("abort", this.abort);
    return this.claim.release();
  }
}

function retainContextEngineFactorySource(
  registration: ContextEngineRegistration | undefined,
): ContextEngineFactoryResources | undefined {
  const claim = registration && registrationSources.get(registration)?.retain();
  return claim ? new ContextEngineFactoryResources(claim) : undefined;
}

/** One instance may come from both factories; every source stays held through shared cleanup. */
export async function disposeContextEngineSources(
  engine: ContextEngine | undefined,
  sources: readonly ContextEngineFactoryResources[],
): Promise<void> {
  const dispose = () => engine?.dispose?.();
  if (sources.length === 0) {
    await dispose();
    return;
  }
  // Start instance cleanup before retiring the factory lifetime that it may need to stop.
  const cleanup = sources[0]!.cleanupWork.track(() => sources[0]!.runCleanup(dispose));
  for (const source of sources) {
    source.context(() => source.work.beginClose());
  }
  const [engineResult] = await Promise.allSettled([cleanup]);
  const scopes = sources.flatMap((source) => [source.work, source.cleanupWork]);
  await AsyncWorkScope.runWhenAllIdle(
    () => scopes,
    () => {
      for (const source of sources) {
        source.cleanupContext(() => source.cleanupWork.beginClose());
      }
    },
  );
  await AsyncWorkScope.runWhenAllIdle(
    () => scopes,
    () =>
      Promise.all(
        sources.flatMap((source) => [
          source.context(() => source.work.drain()),
          source.cleanupContext(() => source.cleanupWork.drain()),
        ]),
      ),
  );
  const released = await Promise.allSettled(sources.map((source) => source.release()));
  if (engineResult.status === "rejected") {
    throw engineResult.reason;
  }
  for (const result of released) {
    if (result.status === "rejected") {
      throw result.reason;
    }
  }
}

type ContextEngineFactoryFailureCleanup = (
  source: ContextEngineFactoryResources | undefined,
) => void;

/** Report selection separately while its admitted owner joins failed-factory cleanup. */
export async function runContextEngineFactoryResolution<T>(
  resolve: (abandon: ContextEngineFactoryFailureCleanup) => Promise<T>,
  onCleanupFailure?: () => void,
): Promise<T> {
  const reportCleanupFailure = onCleanupFailure
    ? AsyncLocalStorage.bind(onCleanupFailure)
    : undefined;
  const result = createDeferredCore<T>();
  const failedSources: Promise<void>[] = [];
  const abandon: ContextEngineFactoryFailureCleanup = (source) => {
    if (source) {
      failedSources.push(
        disposeContextEngineSources(undefined, [source]).catch((error: unknown) => {
          reportCleanupFailure?.();
          console.warn(
            `[context-engine] Failed factory resource cleanup: ${sanitizeForLog(String(error))}`,
          );
        }),
      );
    }
  };
  // Admit construction before either factory can escape into asynchronous work.
  void captureAsyncWorkTracker()(async () => {
    try {
      result.resolve(await resolve(abandon));
    } catch (error) {
      result.reject(error);
    } finally {
      await Promise.all(failedSources);
    }
  }).catch(result.reject);
  return await result.promise;
}

export function retainLogicalTurnContextEngineSources(
  fallback: ContextEngineRegistration | undefined,
  configured: ContextEngineRegistration | undefined,
): {
  fallback: ContextEngineFactoryResources | undefined;
  configured?: ContextEngineFactoryResources;
  configuredFailure?: { error: unknown };
} {
  const fallbackSource = retainContextEngineFactorySource(fallback);
  try {
    const configuredSource =
      configured?.lifecycle === "runtime"
        ? retainContextEngineFactorySource(configured)
        : undefined;
    return { fallback: fallbackSource, configured: configuredSource };
  } catch (error) {
    return { fallback: fallbackSource, configuredFailure: { error } };
  }
}

export async function resolveContextEngineFactory<T extends { engine: ContextEngine }>(
  source: ContextEngineFactoryResources | undefined,
  owners: Map<ContextEngine, ContextEngineFactoryResources[]>,
  create: () => Promise<T>,
): Promise<T> {
  const ref = await (source ? source.run(create) : create());
  if (source) {
    const retained = owners.get(ref.engine) ?? [];
    retained.push(source);
    owners.set(ref.engine, retained);
  }
  return ref;
}
