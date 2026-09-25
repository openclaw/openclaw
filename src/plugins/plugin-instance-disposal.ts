import type { PluginInstanceDisposalResult } from "./plugin-instance.types.js";

export type DisposalCleanup = {
  failures: unknown[];
  hostFailure?: { error: unknown };
  moduleCleanups: Array<() => void | Promise<void>>;
};

export class DisposalFailures extends Set<unknown> {
  private readonly hostErrors = new Set<unknown>();
  private readonly instanceErrors = new Set<unknown>();

  constructor(private readonly isHostCleanup: () => boolean) {
    super();
  }

  override add(error: unknown): this {
    (this.isHostCleanup() ? this.hostErrors : this.instanceErrors).add(error);
    return super.add(error);
  }

  result(errors: readonly unknown[]): PluginInstanceDisposalResult {
    const hostCleanupErrors = [...this.hostErrors].filter(
      (error) => !this.instanceErrors.has(error),
    );
    return { errors, ...(hostCleanupErrors.length ? { hostCleanupErrors } : {}) };
  }
}
