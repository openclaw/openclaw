import type { PluginRegistry } from "../plugins/registry-types.js";
import { AsyncWorkScope } from "../shared/async-work-scope.js";

type RegistryAcquisition = { registry: PluginRegistry; release: () => Promise<void> };

/** The executable owns installed command callbacks until their actual work and cleanup settle. */
export class CliPluginInvocationResources {
  private readonly work = new AsyncWorkScope();
  private readonly acquisitions = new Set<RegistryAcquisition>();
  private readonly registrations = new Set<Promise<void>>();
  private readonly registrationErrors: unknown[] = [];
  private closing = false;
  private released?: Promise<void>;

  run<T>(run: () => T | Promise<T>): Promise<T> {
    if (this.closing) {
      return Promise.reject(new Error("Plugin CLI invocation is closed"));
    }
    return this.work.track(run);
  }

  acquire(load: () => Promise<RegistryAcquisition>): Promise<PluginRegistry> {
    return this.run(async () => {
      const acquisition = await load();
      // Release owns late acquisitions too, even when admission closed during the load.
      this.acquisitions.add(acquisition);
      if (this.closing) {
        throw new Error("Plugin CLI invocation closed during registry acquisition");
      }
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

  release(): Promise<void> {
    if (!this.released) {
      this.closing = true;
      // Publish the result before drain delivers synchronous abort callbacks.
      this.released = Promise.resolve().then(() => this.releaseResources());
    }
    return this.released;
  }

  private async releaseResources(): Promise<void> {
    // Registration disposers can capture this context; terminal closure must follow them.
    this.work.beginClose();
    const results = await this.work.runWhenIdle(() =>
      Promise.allSettled(
        [...this.acquisitions].map((acquisition) => this.work.track(() => acquisition.release())),
      ),
    );
    await this.work.drain();
    this.acquisitions.clear();
    const failures = results.filter((result) => result.status === "rejected");
    if (failures.length > 0) {
      throw new AggregateError(
        failures.map((failure) => failure.reason),
        "Plugin CLI registration resources could not all be disposed",
      );
    }
  }
}
