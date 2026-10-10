import { raceWithTimeout } from "../../packages/retry/src/index.js";
import { formatErrorMessage } from "../infra/errors.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { AsyncWorkScope, trackAsyncWork } from "../shared/async-work-scope.js";
import { createDeferredCore } from "../shared/deferred.js";
import { releasePluginCacheInstance, withPluginCache, type PluginCache } from "./plugin-cache.js";
import { createPluginBackgroundRunner } from "./plugin-instance-background.js";
import { createPluginInstanceBindings } from "./plugin-instance-bindings.js";
import { DisposalFailures, type DisposalCleanup } from "./plugin-instance-disposal.js";
import {
  PluginInstanceDrainTimeoutError,
  PluginInstanceUnavailableError,
} from "./plugin-instance-error.js";
import { pluginInstanceInvocation as invocation } from "./plugin-instance-invocation.js";
import { PluginCallToken } from "./plugin-instance-owned-values.js";
import {
  pluginInstanceState,
  pluginInvocationContext,
  resolvePluginInstanceOwner,
  type PluginInstanceOwner,
} from "./plugin-instance-scope.js";
import { waitForPluginInstanceSettlement } from "./plugin-instance-settlement.js";
import type {
  PluginInstanceCallLease,
  PluginInstanceConsumer,
  PluginInstanceDisposalResult,
  PluginInstanceLifecycle,
  PluginModuleLoaderRecovery,
} from "./plugin-instance.types.js";
import { mapPluginReturnPromise, resolvePluginReturnPromise } from "./plugin-return-value.js";
import { releasePluginInstanceRegistry } from "./registry-lifecycle.js";
import type { PluginRecord, PluginRegistry } from "./registry-types.js";
import { withPluginRuntimePluginScope } from "./runtime/gateway-request-scope.js";
import { getPluginRuntimeGenerationRegistry } from "./runtime/generation-scope.js";

const { values: valueInstances } = pluginInstanceState;
const SHUTDOWN_TIMEOUT_MS = 5_000;
const log = createSubsystemLogger("plugins/cleanup");
type PluginInstanceCall = { registry?: PluginRegistry; cleanup: boolean; ownerJoined: boolean };

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
  private readonly retainedWork = new Set<object>();
  private readonly calls = new Map<object, PluginInstanceCall>();
  private callsExpired = false;
  private forcedRetirement = false;
  private disposalFailures?: Set<unknown>;
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
  private readonly bindings = createPluginInstanceBindings({
    instance: this,
    enter: (token, run) => this.enter(token, run),
    invoke: (run) => this.invoke(run),
    lease: () => this.lease(),
    hasToken: (token) => this.hasToken(token),
    isConsumerToken: (token) => this.consumers.has(token),
  });
  readonly admitFactory = this.bindings.admitFactory;
  readonly wrap = this.bindings.create(
    <T>(run: () => T) => this.run(run),
    <T>(run: () => T) => this.runConsumer(run),
  );
  private disposal?: Promise<PluginInstanceDisposalResult>;
  readonly owner?: PluginInstanceOwner;
  private readonly runtimeScope: Parameters<typeof withPluginRuntimePluginScope>[0];

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
    const record = this.owner?.record;
    this.runtimeScope = Object.freeze({
      pluginId: record?.id ?? pluginId,
      pluginSource: record?.source,
      pluginOrigin: record?.origin,
      pluginTrustedOfficialInstall: record?.trustedOfficialInstall,
    });
    this.lifecycle = Object.freeze({
      signal: this.controller.signal,
      onDispose: (cleanup: () => void | Promise<void>) => this.addCleanup(cleanup, "plugin"),
      runInBackgroundContext: createPluginBackgroundRunner(
        this,
        (token) => this.calls.get(token)?.cleanup === true,
      ),
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
    const call = this.calls.get(token);
    return (
      (call !== undefined &&
        (call.cleanup || (!this.forcedRetirement && (call.ownerJoined || !this.callsExpired)))) ||
      this.consumers.get(token)?.active === true
    );
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

  /** SDK-reachable compatibility: reload checks callers but no longer reserves instances. */
  get replacementPending(): boolean {
    return false;
  }

  holdsPendingReplacement(token: object): boolean {
    return this.replacementPending && this.hasToken(token);
  }

  run<T>(run: () => T): T {
    const current = this.activeCall();
    if (current) {
      return this.invoke(run, { token: current.token, release: () => undefined });
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
    registry: PluginRegistry | undefined,
    run: () => T,
    options?: { joinDisposal?: boolean },
  ): T {
    const current = this.activeCall();
    if (current) {
      return this.invoke(run, { token: current.token, release: () => undefined });
    }
    // Fresh ordinary calls never inherit a scope's retained-consumer admission.
    if (!this.accepting || this.owner?.revoked) {
      throw new PluginInstanceUnavailableError(this.pluginId);
    }
    return this.invoke(run, this.lease({ registry, joinDisposal: options?.joinDisposal }));
  }

  /** Associates an identity-sensitive public value without replacing it with a view. */
  adopt<T>(value: T): T {
    return valueInstances.adopt(value, this);
  }

  createRegistryView(registry: PluginRegistry, invoke: <T>(run: () => T) => T): <T>(value: T) => T {
    return this.bindings.create(<T>(run: () => T) =>
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

  get ordinaryCallCount(): number {
    return [...this.calls.values()].filter((call) => !call.cleanup).length;
  }

  /** Observe admitted work without closing callbacks or idle publication custody. */
  waitForRetainedWork(
    signal: AbortSignal,
    { includeConsumers = true, includeCalls = false } = {},
  ): Promise<void> {
    return waitForPluginInstanceSettlement(
      this.pluginId,
      this.waiters,
      () =>
        (!includeCalls || this.ordinaryCallCount === 0) &&
        (includeConsumers ? this.retainedWorkCount : this.retainedWork.size) === 0,
      signal,
    );
  }

  /** Observe when a pre-stop replacement drain would pass: no retained work or calls, cleanup included. */
  waitForIdle(signal: AbortSignal): Promise<void> {
    return waitForPluginInstanceSettlement(
      this.pluginId,
      this.waiters,
      () => this.calls.size === 0 && this.retainedWorkCount === 0,
      signal,
    );
  }

  /** Refuse a caller-dependent reload before stopping its serving instance. */
  reserveReplacement(): () => void {
    if (this.hasActiveCall) {
      throw new Error(
        `Plugin ${this.pluginId} cannot replace itself from its own active call; retry after the call finishes.`,
      );
    }
    return () => {};
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
    if ((!this.accepting || this.owner?.revoked) && !parent?.active) {
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
      wrap: this.bindings.create(run, run),
      close: (cleanup) => {
        if (!closing && this.consumers.has(token)) {
          // Close operation callbacks before entering a separate host teardown token.
          // Its release must not join the disposal waiting on this physical hold.
          token.active = false;
          closing = new Promise<void>((resolve) => {
            resolve(
              this.invoke(
                cleanup,
                this.lease({ cleanup: true, registry: token.registry }),
                this.disposalFailures,
              ),
            );
          }).finally(release);
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
    const held: { registry?: PluginRegistry } = {};
    try {
      return this.enter(
        token,
        () => {
          const value = run();
          const completion = resolvePluginReturnPromise(value);
          if (completion) {
            const settled = mapPluginReturnPromise(
              completion,
              async (result) => {
                held.registry = undefined;
                await release();
                if (this.forcedRetirement && !cleanup && !this.hasToken(token)) {
                  throw new PluginInstanceUnavailableError(this.pluginId);
                }
                return result;
              },
              async (error: unknown) => {
                held.registry = undefined;
                cleanupFailures?.add(error);
                // Preserve the call's failure; lifecycle observers still receive cleanup failures.
                await release()?.catch(() => {});
                throw error;
              },
            );
            if (settled.host) {
              valueInstances.setHost(settled.value, this);
            } else {
              valueInstances.set(settled.value, this);
            }
            // Then getters and assimilation can execute plugin code; retain the admitting scope.
            // SAFETY: Promise-like calls retain their resolved value while joining owner cleanup.
            return settled.value as T;
          }
          held.registry = undefined;
          void release();
          if (this.forcedRetirement && !cleanup && !this.hasToken(token)) {
            throw new PluginInstanceUnavailableError(this.pluginId);
          }
          return value;
        },
        held,
      );
    } catch (error) {
      held.registry = undefined;
      cleanupFailures?.add(error);
      void release();
      throw error;
    }
  }

  private enter<T>(token: object, run: () => T, held?: { registry?: PluginRegistry }): T {
    pluginInvocationContext.getStore()?.lookup(this);
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
    // Prepared calls keep their registry; detached calls follow the adopted owner.
    const registry =
      this.consumers.get(token)?.registry ??
      this.calls.get(token)?.registry ??
      (generation?.plugins.includes(record) ? generation : this.owner.registry);
    if (!registry) {
      throw new PluginInstanceUnavailableError(record.id);
    }
    if (held) {
      held.registry = registry;
    }
    return withPluginRuntimePluginScope(this.runtimeScope, run, registry, call);
  }

  private lease(
    options: { registry?: PluginRegistry } & (
      | { cleanup?: false; joinDisposal?: boolean }
      | { cleanup: true; hostCleanup?: boolean }
    ) = {},
  ): PluginInstanceCallLease {
    const current = this.activeCall();
    const parent = current && this.calls.get(current.token);
    const registry = options.registry ?? parent?.registry;
    const joinDisposal = !options.cleanup && options.joinDisposal !== false;
    // Nested callbacks and streams keep the consumer's exact token; ordinary
    // tokens could expire early or remain usable after that consumer closes.
    if (!options.registry && current && this.consumers.has(current.token)) {
      return { token: current.token, release: () => undefined };
    }
    const token = new PluginCallToken(
      {},
      (options.cleanup && options.hostCleanup) ||
        (current !== undefined && PluginCallToken.isHostCleanup(current.token)),
    );
    const cleanup = options.cleanup === true || parent?.cleanup === true;
    // Not joining disposal never grants teardown authority to ordinary work; its
    // lifecycle owner stops and joins that work during cleanup instead.
    this.calls.set(token, { registry, cleanup, ownerJoined: !cleanup && !joinDisposal });
    return {
      token,
      release: () => {
        this.calls.delete(token);
        this.waiters.forEach((wake) => wake());
        // Earlier borrowers may feed other calls or hand off a stream. Only the
        // last borrower joins disposal; cleanup callbacks cannot await themselves.
        return joinDisposal && this.calls.size === 0 && !this.controller.signal.aborted
          ? this.disposal
          : undefined;
      },
    };
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
      await this.waitForCalls((token) => token === ownToken, options?.signal);
      if (options?.includeConsumers) {
        await waitForPluginInstanceSettlement(
          this.pluginId,
          this.waiters,
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

  private async waitForCalls(
    ignored: (token: object) => boolean,
    signal?: AbortSignal,
  ): Promise<void> {
    const settled = () => [...this.calls.keys()].every(ignored);
    if (signal) {
      // Reload owns its observation budget; disposal keeps its independent deadline.
      return waitForPluginInstanceSettlement(this.pluginId, this.waiters, settled, signal);
    }
    const deadline = new AbortController();
    const timer = setTimeout(() => {
      deadline.abort(
        new Error(`Plugin ${this.pluginId} still has active calls after ${SHUTDOWN_TIMEOUT_MS}ms`),
      );
    }, SHUTDOWN_TIMEOUT_MS);
    try {
      await waitForPluginInstanceSettlement(this.pluginId, this.waiters, settled, deadline.signal);
    } finally {
      clearTimeout(timer);
    }
  }

  get disposing(): boolean {
    return this.disposal !== undefined;
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
      const terminalFailures = (this.disposalFailures = new DisposalFailures(this));
      const work = new AsyncWorkScope(terminalFailures);
      // Physical cleanup outlives the releasing caller's invocation scope.
      const physical = pluginInvocationContext.exit(() =>
        this.finishDisposal(
          trackAsyncWork(() => this.runDisposalCleanup(work, terminalFailures, beforeCleanup)),
          terminalFailures,
        ),
      );
      const settled = physical.then(() => {
        if (terminalFailures.size) {
          throw new AggregateError(terminalFailures, `Plugin ${this.pluginId} cleanup failed`);
        }
      });
      void settled.catch(() => {});
      this.disposal = new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          const fact = {
            activeCallCount: this.calls.size,
            retainedConsumerCount: this.consumers.size,
          };
          this.forcedRetirement = true;
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
      pluginInvocationContext.exit(() =>
        work.run(() => this.controller.abort(new Error(`Plugin ${this.pluginId} is retiring`))),
      );
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
      // Owner-joined work often stops only when its cleanup runs; draining it
      // first would hold disposal until the deadline.
      await this.waitForCalls((token) => this.calls.get(token)?.ownerJoined === true);
    } catch (error) {
      failures.push(
        new PluginInstanceDrainTimeoutError(
          formatErrorMessage(error),
          this.waitForCalls(() => false, new AbortController().signal),
          { cause: error },
        ),
      );
    }
    // Revoke ordinary call tokens even when they miss their drain deadline.
    // Owner-joined work keeps its token until it settles. Logical consumers
    // retain only their own scope through engine disposal; physical cleanup
    // waits for those consumers to close.
    this.callsExpired = true;
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
      try {
        await raceWithTimeout(runCleanup(cleanup), Math.max(0, deadline - Date.now()), () => {
          throw new Error(`Plugin ${this.pluginId} cleanup did not settle`);
        });
      } catch (error) {
        failures.push(error);
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
    // Expired calls lose authority, but retain their code until they actually return.
    await this.waitForCalls(() => false, new AbortController().signal);
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
      // Native ESM exports can outlive their instance. Keep its revocation identity, not
      // the retired registry and every inspection/prepared resource keyed by that registry.
      if (this.owner) {
        releasePluginInstanceRegistry(this.owner);
      }
    }
    return terminalFailures.result(failures);
  }
}
