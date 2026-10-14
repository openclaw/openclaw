import type { PluginRegistry } from "../plugins/registry-types.js";
import { AsyncWorkScope, isAsyncWorkScopeActiveHere } from "../shared/async-work-scope.js";

type ReleasableResource = { release: () => Promise<void> };
type RegistryAcquisition = ReleasableResource & { registry: PluginRegistry };

/** The executable owns installed command callbacks until their actual work and cleanup settle. */
export class CliPluginInvocationResources {
  private readonly work = new AsyncWorkScope();
  private readonly resources = new Set<ReleasableResource>();
  private readonly registrations = new Set<Promise<void>>();
  private readonly registrationErrors: unknown[] = [];
  private phase: "open" | "cleanup" | "disposing" | "closed" = "open";
  private released?: Promise<void>;

  run<T>(run: () => T | Promise<T>): Promise<T> {
    if (this.phase !== "open") {
      return Promise.reject(new Error("Plugin CLI invocation is closed"));
    }
    return this.work.track(run);
  }

  adopt(resource: ReleasableResource): void {
    if (this.phase !== "open") {
      throw new Error("Plugin CLI invocation is closed");
    }
    this.resources.add(resource);
  }

  acquire(load: () => Promise<RegistryAcquisition>): Promise<PluginRegistry> {
    // Retained cleanup can need its first registry after ordinary admission has closed.
    if (
      this.phase !== "open" &&
      !(this.phase === "cleanup" && isAsyncWorkScopeActiveHere(this.work))
    ) {
      return Promise.reject(new Error("Plugin CLI invocation is closed"));
    }
    return this.work.track(async () => {
      const acquisition = await load();
      // Admitted loads may finish during shutdown; the work scope joins them before disposal.
      this.resources.add(acquisition);
      return acquisition.registry;
    });
  }

  register(run: () => void | Promise<void>): void {
    const pending = this.run(run);
    this.registrations.add(pending);
    void pending.then(
      () => this.registrations.delete(pending),
      (error: unknown) => {
        this.registrationErrors.push(error);
        this.registrations.delete(pending);
      },
    );
  }

  async waitForRegistrations(): Promise<void> {
    while (this.registrations.size > 0) {
      await Promise.allSettled(this.registrations);
    }
    if (this.registrationErrors.length > 0) {
      throw new AggregateError(this.registrationErrors, "CLI command registration failed");
    }
  }

  /** Invoke cleanup in this owner so cooperating descendants join its physical lifetime. */
  runCleanup = <T>(run: () => T | Promise<T>): Promise<T> => this.work.track(run);

  /** Stop admission and cancel cooperating work; final release still owns cleanup ordering. */
  beginClose(reason?: unknown): void {
    if (this.phase === "open") {
      this.phase = "cleanup";
    }
    this.work.beginClose(reason);
  }

  /** Settle admitted work before callers close the resources that work depends on. */
  async settleWork(): Promise<void> {
    this.beginClose();
    await this.work.runWhenIdle(() => {});
  }

  release(): Promise<void> {
    if (!this.released) {
      if (this.phase === "open") {
        this.phase = "cleanup";
      }
      // Publish the result before drain delivers synchronous abort callbacks.
      this.released = Promise.resolve().then(() => this.releaseResources());
    }
    return this.released;
  }

  private async releaseResources(): Promise<void> {
    // Registration disposers can capture this context; terminal closure must follow them.
    this.beginClose();
    const results = await this.work.runWhenIdle(() => {
      // Seal in the same continuation that observes idle, before selecting physical releases.
      this.phase = "disposing";
      return Promise.allSettled(
        [...this.resources].map((acquisition) => this.work.track(() => acquisition.release())),
      );
    });
    await this.work.drain();
    this.phase = "closed";
    this.resources.clear();
    const failures = results.filter((result) => result.status === "rejected");
    if (failures.length > 0) {
      throw new AggregateError(
        failures.map((failure) => failure.reason),
        "Plugin CLI registration resources could not all be disposed",
      );
    }
  }
}
