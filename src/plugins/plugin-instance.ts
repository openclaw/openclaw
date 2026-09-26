import { formatErrorMessage, toErrorObject } from "../infra/errors.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { AsyncWorkScope, trackAsyncWork } from "../shared/async-work-scope.js";
import { createDeferredCore } from "../shared/deferred.js";
import { releasePluginCacheInstance, withPluginCache, type PluginCache } from "./plugin-cache.js";
import { DisposalFailures, type DisposalCleanup } from "./plugin-instance-disposal.js";
import {
  PluginInstanceDrainTimeoutError,
  PluginInstanceUnavailableError,
} from "./plugin-instance-error.js";
import { pluginInstanceInvocation as invocation } from "./plugin-instance-invocation.js";
import {
  pluginInstanceState,
  pluginInvocationContext,
  resolvePluginInstanceOwner,
  type PluginInstanceOwner,
} from "./plugin-instance-scope.js";
import { createPluginValueView } from "./plugin-instance-value-views.js";
import type {
  PluginInstanceCallLease,
  PluginInstanceConsumer,
  PluginInstanceDisposalResult,
  PluginInstanceLifecycle,
  PluginModuleLoaderRecovery,
} from "./plugin-instance.types.js";
import { resolvePluginReturnPromise } from "./plugin-return-value.js";
import type { PluginRecord, PluginRegistry } from "./registry-types.js";
import { withPluginRuntimePluginScope } from "./runtime/gateway-request-scope.js";
import { getPluginRuntimeGenerationRegistry } from "./runtime/generation-scope.js";

const { values: valueInstances } = pluginInstanceState;
const SHUTDOWN_TIMEOUT_MS = 5_000;
const log = createSubsystemLogger("plugins/cleanup");

export class PluginInstance {
  readonly slots = new Map<string | symbol, { runtime: unknown }>();
  readonly controller = new AbortController();
  readonly lifecycle: PluginInstanceLifecycle;
  toolRegistrationComplete = false;
  controlPlaneInitialized = false;
  sourceDigest?: string;
  private moduleLoader?: (source: string) => unknown;
  private setupCache?: PluginCache;
  private captureModuleRecovery?: () => PluginModuleLoaderRecovery;
  private moduleSourceExists?: false | ((source: string) => boolean);
  private accepting = true;
  private replacementReserved = false;
  private readonly retainedWork = new Set<object>();
  private readonly calls = new Map<object, { registry?: PluginRegistry; cleanup: boolean }>();
  private forcedRetirement = false;
  private disposalFailures?: Set<unknown>;
  private readonly hostCleanupCalls = new WeakSet<object>();
  private timedOutCalls?: {
    remaining: Set<object>;
    settled: ReturnType<typeof createDeferredCore<void>>;
  };
  private readonly consumers = new Map<
    object,
    {
      active: boolean;
      completion: Promise<void>;
      registry?: PluginRegistry;
      kind: "work" | "custody";
    }
  >();
  private readonly cleanups = new Map<() => void | Promise<void>, "plugin" | "module">();
  private readonly waiters = new Set<() => void>();
  private readonly originalValues = new WeakMap<object, object>();
  readonly wrap = this.createValueView(
    <T>(run: () => T) => this.run(run),
    <T>(run: () => T) => this.runConsumer(run),
  );
  private disposal?: Promise<PluginInstanceDisposalResult>;
  readonly owner?: PluginInstanceOwner;

  constructor(
    readonly pluginId: string,
    owner?: { record: PluginRecord; registry: PluginRegistry } | { cache: PluginCache },
  ) {
    if (owner && "record" in owner) {
      this.owner = resolvePluginInstanceOwner(owner.record, owner.registry);
      if (this.owner.instance) {
        throw new Error(`Plugin ${pluginId} already owns a runtime instance`);
      }
      this.owner.instance = this;
      pluginInstanceState.records.set(this, this.owner);
    } else {
      this.setupCache = owner?.cache;
    }
    this.lifecycle = Object.freeze({
      signal: this.controller.signal,
      onDispose: (cleanup: () => void | Promise<void>) => this.addCleanup(cleanup, "plugin"),
    });
  }

  private addCleanup(cleanup: () => void | Promise<void>, kind: "plugin" | "module") {
    if (
      this.controller.signal.aborted ||
      ((!this.accepting || this.owner?.revoked) && !this.activeCall())
    ) {
      throw new Error(`Plugin ${this.pluginId} is retiring`);
    }
    this.cleanups.set(cleanup, kind);
    return () => void this.cleanups.delete(cleanup);
  }

  /** Captured module resources retain physical custody after a forced logical retirement. */
  onModuleDispose(cleanup: () => void | Promise<void>): void {
    this.addCleanup(cleanup, "module");
  }

  private hasToken(token: object): boolean {
    return this.calls.has(token) || this.consumers.get(token)?.active === true;
  }

  private activeCall(scope = invocation.getStore()) {
    return scope?.instance === this && this.hasToken(scope.token) ? scope : undefined;
  }

  get acceptingCalls(): boolean {
    return this.accepting;
  }

  get hasActiveCall(): boolean {
    return this.activeCall() !== undefined;
  }

  run<T>(run: () => T): T {
    const current = this.activeCall();
    if (current) {
      return this.enter(current.token, run);
    }
    const scoped = pluginInvocationContext.getStore()?.lookup(this);
    if (scoped) {
      return scoped.run(run);
    }
    if (!this.accepting || this.owner?.revoked) {
      throw new PluginInstanceUnavailableError(this.pluginId);
    }
    return this.invoke(run);
  }

  runInRegistry<T>(
    registry: PluginRegistry,
    run: () => T,
    options?: { joinDisposal?: boolean },
  ): T {
    const current = this.activeCall();
    if (current) {
      return this.enter(current.token, run);
    }
    // Fresh ordinary calls never inherit a scope's retained-consumer admission.
    if (!this.accepting || this.owner?.revoked) {
      throw new PluginInstanceUnavailableError(this.pluginId);
    }
    return this.invoke(run, this.lease({ registry, joinDisposal: options?.joinDisposal }));
  }

  /** Associates an identity-sensitive public value without replacing it with a view. */
  adopt<T>(value: T): T {
    const seen = new WeakSet<object>();
    const visit = (candidate: unknown) => {
      if (
        !candidate ||
        (typeof candidate !== "object" && typeof candidate !== "function") ||
        seen.has(candidate)
      ) {
        return;
      }
      seen.add(candidate);
      valueInstances.set(candidate, this);
      for (const descriptor of Object.values(Object.getOwnPropertyDescriptors(candidate))) {
        if ("value" in descriptor) {
          visit(descriptor.value);
        }
      }
    };
    visit(value);
    return value;
  }

  createRegistryView(registry: PluginRegistry, invoke: <T>(run: () => T) => T): <T>(value: T) => T {
    return this.createValueView(<T>(run: () => T) =>
      invoke(() => this.runInRegistry(registry, run)),
    );
  }

  /** Detached host consumption retains its completion independently of its admitting caller. */
  runConsumer<T>(consume: () => T): T {
    return this.activeCall() ? this.invoke(consume) : this.run(consume);
  }

  get hasRetainedConsumers(): boolean {
    return this.consumers.size > 0;
  }

  /** Track finite host work without granting invocation authority or joining disposal. */
  retainWork(): () => void {
    if (this.replacementReserved) {
      throw new Error(`Plugin ${this.pluginId} replacement is in progress`);
    }
    const token = {};
    this.retainedWork.add(token);
    return () => {
      if (this.retainedWork.delete(token)) {
        this.waiters.forEach((wake) => wake());
      }
    };
  }

  get retainedWorkCount(): number {
    return (
      this.retainedWork.size +
      [...this.consumers.values()].filter(({ kind }) => kind === "work").length
    );
  }

  /** Observe host settlement without closing the callbacks that retained runs still need. */
  async waitForRetainedWork(signal: AbortSignal, includeConsumers = true): Promise<void> {
    await this.waitForSettlement(
      () => (includeConsumers ? this.retainedWorkCount : this.retainedWork.size) === 0,
      signal,
    );
  }

  private async waitForSettlement(settled: () => boolean, signal: AbortSignal): Promise<void> {
    signal.throwIfAborted();
    if (settled()) {
      return;
    }
    await new Promise<void>((resolve, reject) => {
      const cleanup = () => {
        this.waiters.delete(wake);
        signal.removeEventListener("abort", abort);
      };
      const wake = () => {
        if (settled()) {
          cleanup();
          resolve();
        }
      };
      const abort = () => {
        cleanup();
        reject(toErrorObject(signal.reason, `Plugin ${this.pluginId} work drain aborted`));
      };
      this.waiters.add(wake);
      signal.addEventListener("abort", abort, { once: true });
    });
  }

  /** Reserve replacement atomically before host owners invalidate or stop this instance. */
  reserveReplacement(): () => void {
    if (this.hasActiveCall) {
      throw new Error(
        `Plugin ${this.pluginId} cannot replace itself from its own active call; retry after the call finishes.`,
      );
    }
    if (this.replacementReserved) {
      throw new Error(`Plugin ${this.pluginId} replacement is in progress`);
    }
    this.replacementReserved = true;
    let released = false;
    return () => {
      if (!released) {
        released = true;
        this.replacementReserved = false;
      }
    };
  }

  /** Retain executable use or idle donor custody through its physical completion. */
  retainConsumer(
    invoke?: <T>(run: () => T) => T,
    registry?: PluginRegistry,
    kind: "work" | "custody" = "work",
  ): PluginInstanceConsumer {
    const current = this.activeCall();
    const parent = current && this.consumers.get(current.token);
    // Only an exact live retained consumer can derive admission after ordinary closure.
    if (
      (this.replacementReserved && parent?.kind !== "work") ||
      ((!this.accepting || this.owner?.revoked) && !parent?.active)
    ) {
      throw new Error(`Plugin ${this.pluginId} is retiring`);
    }
    const released = createDeferredCore();
    const token = { active: true, completion: released.promise, registry, kind };
    this.consumers.set(token, token);
    let closing: Promise<void> | undefined;
    const release = () => {
      token.active = false;
      if (this.consumers.delete(token)) {
        released.resolve();
        this.waiters.forEach((wake) => wake());
      }
    };
    const run = <T>(consume: () => T): T => {
      if (!token.active) {
        throw new Error(`Plugin ${this.pluginId} consumer is closed`);
      }
      const call = () => this.invoke(consume, { token, release: () => undefined });
      return invoke ? invoke(call) : call();
    };
    return {
      run,
      wrap: this.createValueView(run, run),
      close: (cleanup) => {
        if (!closing && this.consumers.has(token)) {
          // Close operation callbacks before entering a separate host teardown token.
          // Its release must not join the disposal waiting on this physical hold.
          token.active = false;
          const completion = createDeferredCore();
          closing = completion.promise.finally(release);
          try {
            completion.resolve(
              this.invoke(
                cleanup,
                this.lease({ cleanup: true, registry: token.registry }),
                this.disposalFailures,
              ),
            );
          } catch (error) {
            completion.reject(error);
          }
        }
        return closing ?? Promise.reject(new Error(`Plugin ${this.pluginId} consumer is closed`));
      },
      release: () => {
        if (!closing) {
          release();
        }
      },
    };
  }

  /** Only lifecycle owners may admit teardown after ordinary calls have stopped. */
  runCleanup<T>(run: () => T): T {
    const current = this.activeCall();
    if (!current) {
      this.controller.signal.throwIfAborted();
    }
    // Cleanup must not join the disposal that is waiting for this invocation.
    return this.invoke(
      run,
      current ? { token: current.token, release: () => undefined } : this.lease({ cleanup: true }),
      this.disposalFailures,
    );
  }

  private invoke<T>(
    run: () => T,
    { token, release }: PluginInstanceCallLease = this.lease(),
    cleanupFailures?: Set<unknown>,
  ): T {
    const cleanup = this.calls.get(token)?.cleanup === true;
    try {
      return this.enter(token, () => {
        const value = run();
        const completion = resolvePluginReturnPromise(value);
        if (completion) {
          const settled = completion.then(
            async (result) => {
              await release();
              if (this.forcedRetirement && !cleanup && !this.hasToken(token)) {
                throw new PluginInstanceUnavailableError(this.pluginId);
              }
              return result;
            },
            async (error: unknown) => {
              cleanupFailures?.add(error);
              // Preserve the call's failure; lifecycle observers still receive cleanup failures.
              await release()?.catch(() => {});
              throw error;
            },
          );
          valueInstances.set(settled, this);
          // Then getters and assimilation can execute plugin code; retain the admitting scope.
          // SAFETY: Promise-like calls retain their resolved value while joining owner cleanup.
          return settled as T;
        }
        void release();
        if (this.forcedRetirement && !cleanup && !this.hasToken(token)) {
          throw new PluginInstanceUnavailableError(this.pluginId);
        }
        return value;
      });
    } catch (error) {
      cleanupFailures?.add(error);
      void release();
      throw error;
    }
  }

  private enter<T>(token: object, run: () => T): T {
    const current = invocation.getStore();
    const call =
      current?.instance === this && current.token === token ? current : { instance: this, token };
    if (!this.owner) {
      const enter = () => invocation.run(call, run);
      // Deferred setup imports use the same SDK resolver facts as their initial load.
      return this.setupCache ? withPluginCache(this.setupCache, enter) : enter();
    }
    const { record } = this.owner;
    const generation = getPluginRuntimeGenerationRegistry();
    // Prepared callers retain their catalog; detached work follows the same
    // instance when publication adopts it into a replacement registry.
    const registry =
      this.consumers.get(token)?.registry ??
      this.calls.get(token)?.registry ??
      (generation?.plugins.includes(record) ? generation : this.owner.registry);
    return withPluginRuntimePluginScope(
      {
        pluginId: record.id,
        pluginSource: record.source,
        pluginOrigin: record.origin,
        pluginTrustedOfficialInstall: record.trustedOfficialInstall,
      },
      run,
      registry,
      call,
    );
  }

  private lease(
    options: { registry?: PluginRegistry } & (
      | { cleanup?: false; joinDisposal?: boolean }
      | { cleanup: true; hostCleanup?: boolean }
    ) = {},
  ): PluginInstanceCallLease {
    const { registry } = options;
    const joinDisposal = !options.cleanup && options.joinDisposal !== false;
    // Nested callbacks and streams keep the consumer's exact token; ordinary
    // tokens could expire early or remain usable after that consumer closes.
    const current = this.activeCall();
    if (!registry && current && this.consumers.has(current.token)) {
      return { token: current.token, release: () => undefined };
    }
    const token = {};
    if (
      (options.cleanup && options.hostCleanup) ||
      (current && this.hostCleanupCalls.has(current.token))
    ) {
      this.hostCleanupCalls.add(token);
    }
    this.calls.set(token, {
      registry,
      // Not joining disposal never grants teardown authority to ordinary work.
      cleanup:
        options.cleanup === true || (current && this.calls.get(current.token)?.cleanup) === true,
    });
    return {
      token,
      release: () => {
        this.calls.delete(token);
        const timedOut = this.timedOutCalls;
        if (timedOut?.remaining.delete(token) && timedOut.remaining.size === 0) {
          this.timedOutCalls = undefined;
          timedOut.settled.resolve();
        }
        this.waiters.forEach((wake) => wake());
        // Earlier borrowers may feed other calls or hand off a stream. Only the
        // last borrower joins disposal; cleanup callbacks cannot await themselves.
        return joinDisposal && this.calls.size === 0 && !this.controller.signal.aborted
          ? this.disposal
          : undefined;
      },
    };
  }

  private createValueView(
    admit: <T>(run: () => T) => T,
    admitCallback: <T>(run: () => T) => T = (run) => admit(() => this.invoke(run)),
  ): <T>(value: T) => T {
    return createPluginValueView(
      {
        instance: this,
        originalValues: this.originalValues,
        invoke: (run, lease) => this.invoke(run, lease),
        lease: () => this.lease(),
        hasToken: (token) => this.hasToken(token),
      },
      admit,
      admitCallback,
    );
  }

  bindModuleLoader(
    load: (source: string) => unknown,
    hasSource?: (source: string) => boolean,
  ): void {
    if (this.moduleLoader) {
      throw new Error(`Plugin ${this.pluginId} already owns its module loader`);
    }
    this.moduleLoader = load;
    this.moduleSourceExists = hasSource;
  }

  loadModule(source: string): unknown {
    return this.run(() => {
      if (!this.moduleLoader) {
        throw new Error(`Plugin ${this.pluginId} has no captured module loader`);
      }
      return this.wrap(this.moduleLoader(source));
    });
  }

  hasModuleSource(source: string): boolean | undefined {
    return this.moduleSourceExists && this.moduleSourceExists(source);
  }

  bindModuleLoaderRecovery(capture: () => PluginModuleLoaderRecovery): void {
    this.captureModuleRecovery = capture;
  }

  captureModuleLoaderRecovery(): PluginModuleLoaderRecovery {
    if (this.disposing || this.owner?.revoked || this.controller.signal.aborted) {
      throw new PluginInstanceUnavailableError(this.pluginId);
    }
    // A failed drain can leave this owner quiesced, still holding its original
    // loader. Host capture may copy that code without reopening ordinary calls.
    return this.runCleanup(() => {
      if (!this.captureModuleRecovery) {
        throw new Error(`Plugin ${this.pluginId} has no recoverable module loader`);
      }
      return this.captureModuleRecovery();
    });
  }

  quiesce(): boolean {
    const accepting = this.accepting;
    this.accepting = false;
    return accepting;
  }

  async drain(options?: {
    includeConsumers?: boolean;
    signal?: AbortSignal;
  }): Promise<PluginInstanceDisposalResult> {
    this.quiesce();
    const ownToken = this.activeCall()?.token;
    try {
      await this.waitForCalls(ownToken, options?.signal);
      if (options?.includeConsumers) {
        await this.waitForSettlement(
          () => this.consumers.size === 0,
          options.signal ?? new AbortController().signal,
        );
      }
      return { errors: [] };
    } catch (error) {
      // A cancelled observation leaves admitted work and physical resources owned.
      return { errors: [error] };
    }
  }

  private async waitForCalls(ownToken?: object, signal?: AbortSignal): Promise<void> {
    const settled = () => [...this.calls.keys()].every((token) => token === ownToken);
    if (signal) {
      // Reload owns its observation budget; disposal keeps its independent deadline.
      return this.waitForSettlement(settled, signal);
    }
    const deadline = new AbortController();
    const timer = setTimeout(() => {
      deadline.abort(
        new Error(`Plugin ${this.pluginId} still has active calls after ${SHUTDOWN_TIMEOUT_MS}ms`),
      );
    }, SHUTDOWN_TIMEOUT_MS);
    try {
      await this.waitForSettlement(settled, deadline.signal);
    } finally {
      clearTimeout(timer);
    }
  }

  get disposing(): boolean {
    return this.disposal !== undefined;
  }

  private trackTimedOutCalls(): Promise<void> {
    const { remaining, settled } = this.timedOutCalls ?? {
      remaining: new Set<object>(),
      settled: createDeferredCore(),
    };
    for (const token of this.calls.keys()) {
      remaining.add(token);
    }
    if (remaining.size) {
      // Revoking admission below cannot stand in for these leases actually returning.
      this.timedOutCalls = { remaining, settled };
    } else {
      settled.resolve();
    }
    return settled.promise;
  }

  resume(): void {
    this.accepting ||= !this.disposal && !this.controller.signal.aborted && !this.owner?.revoked;
  }

  dispose(beforeCleanup?: () => void | Promise<void>): Promise<PluginInstanceDisposalResult> {
    if (beforeCleanup && this.disposal) {
      return Promise.reject(new Error(`Plugin ${this.pluginId} disposal already started`));
    }
    if (!this.disposal) {
      this.quiesce();
      const terminalFailures = (this.disposalFailures = new DisposalFailures(() => {
        const current = invocation.getStore();
        // Async failure observers retain their originating token after its call has returned.
        return current?.instance === this && this.hostCleanupCalls.has(current.token);
      }));
      const work = new AsyncWorkScope(terminalFailures);
      // Shared state owners still join real cleanup, independently of code-file custody.
      const cleanup = trackAsyncWork(() =>
        this.runDisposalCleanup(work, terminalFailures, beforeCleanup),
      );
      const physical = this.finishDisposal(cleanup, terminalFailures);
      const settled = physical.then(() => {
        if (terminalFailures.size) {
          throw new AggregateError(terminalFailures, `Plugin ${this.pluginId} cleanup failed`);
        }
      });
      void settled.catch(() => {});
      this.disposal = new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          const fact = {
            activeCallCount: new Set([
              ...this.calls.keys(),
              ...(this.timedOutCalls?.remaining ?? []),
            ]).size,
            retainedConsumerCount: this.consumers.size,
          };
          this.forcedRetirement = true;
          void this.trackTimedOutCalls();
          for (const [token, call] of this.calls) {
            if (!call.cleanup) {
              this.calls.delete(token);
            }
          }
          // Admitted consumers keep their own authority until the host closes or releases them.
          this.abortDisposal(work);
          const error = new PluginInstanceDrainTimeoutError(
            `Plugin ${this.pluginId} forced retirement after ${SHUTDOWN_TIMEOUT_MS}ms: ${fact.activeCallCount} still-running call(s), ${fact.retainedConsumerCount} retained consumer(s); resource cleanup remains pending.`,
            settled,
            {},
            fact,
          );
          log.warn(error.message);
          resolve(terminalFailures.result([error, ...terminalFailures]));
        }, SHUTDOWN_TIMEOUT_MS);
        void physical.then(resolve, reject).finally(() => clearTimeout(timer));
      });
      // Self-retirement is joined by the last returning call or stream.
      void this.disposal.catch(() => {});
    }
    return this.activeCall() ? Promise.resolve({ errors: [] }) : this.disposal;
  }

  private abortDisposal(work: AsyncWorkScope): void {
    if (!this.controller.signal.aborted) {
      work.run(() => this.controller.abort(new Error(`Plugin ${this.pluginId} is retiring`)));
    }
  }

  private async runDisposalCleanup(
    cleanupWork: AsyncWorkScope,
    terminalFailures: Set<unknown>,
    beforeCleanup?: () => void | Promise<void>,
  ): Promise<DisposalCleanup> {
    if (this.owner) {
      this.owner.revoked = true;
    }
    const failures: unknown[] = [];
    let hostFailure: { error: unknown } | undefined;
    const runCleanup = (cleanup: () => void | Promise<void>, hostCleanup = false) =>
      cleanupWork.track(() =>
        this.invoke(cleanup, this.lease({ cleanup: true, hostCleanup }), terminalFailures),
      );
    try {
      await this.waitForCalls();
    } catch (error) {
      failures.push(
        new PluginInstanceDrainTimeoutError(formatErrorMessage(error), this.trackTimedOutCalls(), {
          cause: error,
        }),
      );
    }
    // Revoke ordinary call tokens even when they miss their drain deadline.
    // Logical consumers retain only their own scope through engine disposal;
    // physical cleanup waits for those consumers to close.
    for (const [token, call] of this.calls) {
      if (!call.cleanup) {
        this.calls.delete(token);
      }
    }
    while (this.consumers.size > 0) {
      await Promise.all([...this.consumers.values()].map(({ completion }) => completion));
    }
    if (beforeCleanup) {
      // Host hooks own their bounds; explicit cleanup starts its budget after they settle.
      try {
        // This internal lease cannot join the disposal promise awaiting these hooks.
        await runCleanup(beforeCleanup, true);
      } catch (error) {
        // Host admission/persistence guards are not plugin cleanup callbacks.
        hostFailure = { error };
      }
    }
    const deadline = Date.now() + SHUTDOWN_TIMEOUT_MS;
    this.abortDisposal(cleanupWork);
    const moduleCleanups: Array<() => void | Promise<void>> = [];
    for (const [cleanup, kind] of Array.from(this.cleanups).toReversed()) {
      if (kind === "module") {
        moduleCleanups.push(cleanup);
        continue;
      }
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([
          runCleanup(cleanup),
          new Promise<never>((_, reject) => {
            timer = setTimeout(
              () => reject(new Error(`Plugin ${this.pluginId} cleanup did not settle`)),
              Math.max(0, deadline - Date.now()),
            );
          }),
        ]);
      } catch (error) {
        failures.push(error);
      } finally {
        clearTimeout(timer);
      }
    }
    await cleanupWork.drain();
    return { failures, hostFailure, moduleCleanups };
  }

  private async finishDisposal(
    cleanupCompletion: Promise<DisposalCleanup>,
    terminalFailures: DisposalFailures,
  ): Promise<PluginInstanceDisposalResult> {
    const { failures, hostFailure, moduleCleanups } = await cleanupCompletion;
    // Logical expiry revokes results; it cannot delete code still used by the original calls.
    await this.timedOutCalls?.settled.promise;
    for (const cleanup of moduleCleanups) {
      try {
        await this.invoke(cleanup, this.lease({ cleanup: true }));
      } catch (error) {
        failures.push(error);
        terminalFailures.add(error);
      }
    }
    this.cleanups.clear();
    this.calls.clear();
    this.waiters.forEach((wake) => wake());
    this.moduleLoader = undefined;
    this.setupCache = undefined;
    this.captureModuleRecovery = undefined;
    // Release captured paths without reopening the never-bound bundled-library fallback.
    this.moduleSourceExists &&= false;
    this.slots.clear();
    for (const failure of terminalFailures) {
      if (!failures.includes(failure)) {
        failures.push(failure);
      }
    }
    if (failures.length) {
      log.warn(
        `Plugin ${this.pluginId} cleanup failed: ${failures.map(formatErrorMessage).join("; ")}`,
      );
    }
    if (hostFailure) {
      throw hostFailure.error;
    }
    if (failures.length === 0) {
      releasePluginCacheInstance(this);
    }
    return terminalFailures.result(failures);
  }
}
