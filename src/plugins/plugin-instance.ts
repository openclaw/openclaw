import { formatErrorMessage } from "../infra/errors.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { createDeferredCore } from "../shared/deferred.js";
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
} from "./plugin-instance.types.js";
import { resolvePluginReturnPromise } from "./plugin-return-value.js";
import type { PluginRecord, PluginRegistry } from "./registry-types.js";
import {
  withPluginRuntimePluginScope,
  withPluginRuntimeRegistryScope,
} from "./runtime/gateway-request-scope.js";
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
  private moduleLoader?: (source: string) => unknown;
  private moduleSourceExists?: (source: string) => boolean;
  private accepting = true;
  private readonly calls = new Map<object, PluginRegistry | undefined>();
  private readonly consumers = new Map<
    object,
    { active: boolean; completion: Promise<void>; registry?: PluginRegistry }
  >();
  private readonly cleanups = new Set<() => void | Promise<void>>();
  private readonly waiters = new Set<() => void>();
  private readonly originalValues = new WeakMap<object, object>();
  readonly wrap = this.createValueView(<T>(run: () => T) => this.run(run));
  private disposal?: Promise<PluginInstanceDisposalResult>;
  readonly owner?: PluginInstanceOwner;

  constructor(
    readonly pluginId: string,
    owner?: { record: PluginRecord; registry: PluginRegistry },
  ) {
    if (owner) {
      this.owner = resolvePluginInstanceOwner(owner.record, owner.registry);
      if (this.owner.instance) {
        throw new Error(`Plugin ${pluginId} already owns a runtime instance`);
      }
      this.owner.instance = this;
      pluginInstanceState.records.set(this, this.owner);
    }
    this.lifecycle = Object.freeze({
      signal: this.controller.signal,
      onDispose: (cleanup: () => void | Promise<void>) => {
        if (
          this.controller.signal.aborted ||
          ((!this.accepting || this.owner?.revoked) && !this.activeCall())
        ) {
          throw new Error(`Plugin ${pluginId} is retiring`);
        }
        this.cleanups.add(cleanup);
        return () => void this.cleanups.delete(cleanup);
      },
    });
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
      throw new Error(`Plugin ${this.pluginId} was reloaded or disabled; use its current tools.`);
    }
    return this.invoke(run);
  }

  runInRegistry<T>(registry: PluginRegistry, run: () => T): T {
    const current = this.activeCall();
    if (current) {
      return this.enter(current.token, run);
    }
    // Fresh ordinary calls never inherit a scope's retained-consumer admission.
    if (!this.accepting || this.owner?.revoked) {
      throw new Error(`Plugin ${this.pluginId} was reloaded or disabled; use its current tools.`);
    }
    return this.invoke(run, this.lease(true, registry));
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

  retainConsumer(
    invoke?: <T>(run: () => T) => T,
    registry?: PluginRegistry,
  ): PluginInstanceConsumer {
    const current = this.activeCall();
    const parent = current && this.consumers.get(current.token);
    // Only an exact live retained consumer can derive admission after ordinary closure.
    if ((!this.accepting || this.owner?.revoked) && !parent?.active) {
      throw new Error(`Plugin ${this.pluginId} is retiring`);
    }
    const released = createDeferredCore();
    const token = { active: true, completion: released.promise, registry };
    this.consumers.set(token, token);
    let closing: Promise<void> | undefined;
    const release = () => {
      token.active = false;
      if (this.consumers.delete(token)) {
        released.resolve();
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
      wrap: this.createValueView(run),
      close: (cleanup) => {
        if (!closing && token.active) {
          // Close operation callbacks before entering a separate host teardown token.
          // Its release must not join the disposal waiting on this physical hold.
          token.active = false;
          closing = Promise.resolve()
            .then(() => this.invoke(cleanup, this.lease(false)))
            .finally(release);
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
    if (current) {
      return this.enter(current.token, run);
    }
    this.controller.signal.throwIfAborted();
    // Cleanup must not join the disposal that is waiting for this invocation.
    return this.invoke(run, this.lease(false));
  }

  private invoke<T>(run: () => T, { token, release }: PluginInstanceCallLease = this.lease()): T {
    try {
      return this.enter(token, () => {
        const value = run();
        const completion = resolvePluginReturnPromise(value);
        if (completion) {
          const settled = completion.then(
            async (result) => {
              await release();
              return result;
            },
            async (error: unknown) => {
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
        return value;
      });
    } catch (error) {
      void release();
      throw error;
    }
  }

  private enter<T>(token: object, run: () => T): T {
    const invoke = () => invocation.run({ instance: this, token }, run);
    if (!this.owner) {
      return invoke();
    }
    const { record } = this.owner;
    const generation = getPluginRuntimeGenerationRegistry();
    // Prepared callers retain their catalog; detached work follows the same
    // instance when publication adopts it into a replacement registry.
    const registry =
      this.consumers.get(token)?.registry ??
      this.calls.get(token) ??
      (generation?.plugins.includes(record) ? generation : this.owner.registry);
    return withPluginRuntimeRegistryScope(registry, () =>
      withPluginRuntimePluginScope(
        {
          pluginId: record.id,
          pluginSource: record.source,
          pluginOrigin: record.origin,
          pluginTrustedOfficialInstall: record.trustedOfficialInstall,
        },
        invoke,
      ),
    );
  }

  private lease(joinDisposal = true, registry?: PluginRegistry): PluginInstanceCallLease {
    // Nested callbacks and streams keep the consumer's exact token; ordinary
    // tokens could expire early or remain usable after that consumer closes.
    const current = this.activeCall();
    if (!registry && current && this.consumers.has(current.token)) {
      return { token: current.token, release: () => undefined };
    }
    const token = {};
    this.calls.set(token, registry);
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

  private createValueView(admit: <T>(run: () => T) => T): <T>(value: T) => T {
    return createPluginValueView(
      {
        instance: this,
        originalValues: this.originalValues,
        invoke: (run, lease) => this.invoke(run, lease),
        lease: () => this.lease(),
        hasToken: (token) => this.hasToken(token),
      },
      admit,
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
    return this.moduleSourceExists?.(source);
  }

  quiesce(): boolean {
    const accepting = this.accepting;
    this.accepting = false;
    return accepting;
  }

  async drain(): Promise<PluginInstanceDisposalResult> {
    this.quiesce();
    const ownToken = this.activeCall()?.token;
    try {
      await this.waitForCalls(ownToken);
      return { errors: [] };
    } catch (error) {
      // waitForCalls rejects only its own bounded drain deadline.
      return { errors: [error] };
    }
  }

  private async waitForCalls(ownToken?: object): Promise<void> {
    const settled = () => [...this.calls.keys()].every((token) => token === ownToken);
    if (settled()) {
      return;
    }
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.waiters.delete(wake);
        reject(
          new Error(
            `Plugin ${this.pluginId} still has active calls after ${SHUTDOWN_TIMEOUT_MS}ms`,
          ),
        );
      }, SHUTDOWN_TIMEOUT_MS);
      const wake = () => {
        if (settled()) {
          clearTimeout(timer);
          this.waiters.delete(wake);
          resolve();
        }
      };
      this.waiters.add(wake);
    });
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
      this.disposal = this.finishDisposal(beforeCleanup);
      // Self-retirement is joined by the last returning call or stream.
      void this.disposal.catch(() => {});
    }
    return this.activeCall() ? Promise.resolve({ errors: [] }) : this.disposal;
  }

  private async finishDisposal(
    beforeCleanup?: () => void | Promise<void>,
  ): Promise<PluginInstanceDisposalResult> {
    if (this.owner) {
      this.owner.revoked = true;
    }
    const failures: unknown[] = [];
    let hostFailure: { error: unknown } | undefined;
    try {
      await this.waitForCalls();
    } catch (error) {
      failures.push(error);
    }
    // Revoke ordinary call tokens even when they miss their drain deadline.
    // Logical consumers retain only their own scope through engine disposal;
    // physical cleanup waits for those consumers to close.
    this.calls.clear();
    await Promise.all([...this.consumers.values()].map(({ completion }) => completion));
    if (beforeCleanup) {
      // Host hooks own their bounds; explicit cleanup starts its budget after they settle.
      try {
        // This internal lease cannot join the disposal promise awaiting these hooks.
        await this.invoke(beforeCleanup, this.lease(false));
      } catch (error) {
        // Host admission/persistence guards are not plugin cleanup callbacks.
        hostFailure = { error };
      }
    }
    const deadline = Date.now() + SHUTDOWN_TIMEOUT_MS;
    const reason = new Error(`Plugin ${this.pluginId} is retiring`);
    this.controller.abort(reason);
    for (const cleanup of Array.from(this.cleanups).toReversed()) {
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([
          this.invoke(cleanup),
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
    this.cleanups.clear();
    this.calls.clear();
    this.waiters.forEach((wake) => wake());
    this.moduleLoader = undefined;
    this.slots.clear();
    if (failures.length) {
      log.warn(
        `Plugin ${this.pluginId} cleanup failed: ${failures.map(formatErrorMessage).join("; ")}`,
      );
    }
    if (hostFailure) {
      throw hostFailure.error;
    }
    return { errors: failures };
  }
}
