import { PluginInstanceDrainTimeoutError } from "./plugin-instance-error.js";
import { pluginInstanceInvocation } from "./plugin-instance-invocation.js";
import { PluginCallToken } from "./plugin-instance-owned-values.js";
import type {
  PluginInstanceDisposalResult,
  PluginInvocationInstance,
} from "./plugin-instance.types.js";
import {
  PluginRuntimeCloseRetainedError,
  type PluginCleanupRecovery,
} from "./runtime-close-error.js";

export type DisposalCleanupKind = "plugin" | { recovery?: PluginCleanupRecovery };

export type DisposalCleanup = {
  failures: unknown[];
  hostFailure?: { error: unknown };
  moduleCleanups: Array<{ cleanup: () => void | Promise<void>; recovery?: PluginCleanupRecovery }>;
};

export class DisposalFailures extends Set<unknown> {
  private readonly hostErrors = new Set<unknown>();
  private readonly instanceErrors = new Set<unknown>();
  private readonly resourceErrors = new Set<unknown>();
  private readonly resourceRecoveries = new Map<unknown, PluginCleanupRecovery>();
  private pendingRecoveries = 0;
  private releaseCustody?: () => void;

  // A classifier closure created in dispose also captures its beforeCleanup callback.
  constructor(private readonly instance: PluginInvocationInstance) {
    super();
  }

  override add(error: unknown): this {
    // Late observers retain their original token after its call has returned.
    const current = pluginInstanceInvocation.getStore();
    const isHostCleanup =
      current?.instance === this.instance && PluginCallToken.isHostCleanup(current.token);
    (isHostCleanup ? this.hostErrors : this.instanceErrors).add(error);
    return super.add(error);
  }

  /** Resource cleanup failures retain custody even after their callback settles. */
  addResourceError(error: unknown, recovery?: PluginCleanupRecovery): void {
    // Keep raw diagnoses intact; only explicit host capabilities authorize repeat cleanup.
    const retained = recovery
      ? new PluginRuntimeCloseRetainedError(error, {
          isReleased: () => recovery.isReleased(),
          recover: async () => {
            this.pendingRecoveries += 1;
            try {
              await recovery.recover();
            } finally {
              this.pendingRecoveries -= 1;
              this.reconcileCustody();
            }
          },
        })
      : error;
    if (recovery) {
      this.resourceRecoveries.set(error, recovery);
      this.resourceRecoveries.set(retained, recovery);
    }
    this.resourceErrors.add(retained);
    this.add(retained);
  }

  /** Host prerequisites must settle before explicit resource release can end cache custody. */
  settle(errors: readonly unknown[], releaseCustody: () => void): void {
    if (errors.some((error) => !this.resourceRecoveries.has(error))) {
      return;
    }
    this.releaseCustody = releaseCustody;
    this.reconcileCustody();
  }

  private reconcileCustody(): void {
    if (!this.releaseCustody || this.pendingRecoveries) {
      return;
    }
    try {
      if ([...this.resourceRecoveries.values()].some((recovery) => !recovery.isReleased())) {
        return;
      }
    } catch {
      // An unknown physical state cannot authorize releasing the birth inventory.
      return;
    }
    const release = this.releaseCustody;
    this.releaseCustody = undefined;
    release();
  }

  result(errors: readonly unknown[]): PluginInstanceDisposalResult {
    const hostCleanupErrors = [...this.hostErrors].filter(
      (error) => !this.instanceErrors.has(error),
    );
    const retainedErrors = errors.filter(
      (error) => this.resourceErrors.has(error) || error instanceof PluginInstanceDrainTimeoutError,
    );
    return {
      errors,
      ...(retainedErrors.length ? { retainedErrors } : {}),
      ...(hostCleanupErrors.length ? { hostCleanupErrors } : {}),
    };
  }
}
