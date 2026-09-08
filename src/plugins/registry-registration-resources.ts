import { AsyncWorkScope, trackAsyncWork } from "../shared/async-work-scope.js";

export type RegistrationDisposer = { id: string; dispose: () => void | Promise<void> };
type RegistrationResources = {
  disposers: RegistrationDisposer[];
  work: AsyncWorkScope;
  rolledBack?: boolean;
  disposal?: Promise<Error[]>;
  disposalStarted?: boolean;
};

/** Physical registration custody, independent of registry execution authority. */
export class PluginRegistrationResourceSource {
  readonly #registrations = new Map<string, RegistrationResources>();
  readonly #pending = new Set<Promise<void>>();
  #claims = 0;
  #closed = false;

  acquireClaim(owner: "inspection" | "borrower"): { release: () => Promise<Error[]> } {
    if (this.#closed) {
      throw new Error("Plugin registration resources have been released");
    }
    this.#claims++;
    let release: Promise<Error[]> | undefined;
    return {
      release: () => {
        if (!release) {
          const last = --this.#claims === 0;
          this.#closed = last;
          release = Promise.resolve().then(async () => {
            const entries = [...this.#registrations]
              // Construction owns rollback failures; the last claim owns successful entries.
              .filter(([, entry]) => (entry.rolledBack ? owner === "inspection" : last));
            // Signal the entire closing batch before scheduling any disposal idle gate.
            for (const [, entry] of entries) {
              entry.work.beginClose();
            }
            const disposals = entries.map(([pluginId, entry]) => this.#dispose(pluginId, entry));
            await this.#waitForRegistrations();
            const results = await Promise.all(disposals);
            return results.flat();
          });
        }
        return release;
      },
    };
  }

  #registration(pluginId: string): RegistrationResources {
    let entry = this.#registrations.get(pluginId);
    if (!entry) {
      entry = { disposers: [], work: new AsyncWorkScope() };
      this.#registrations.set(pluginId, entry);
    }
    return entry;
  }

  runRegistration(pluginId: string, run: () => void): void {
    const entry = this.#registration(pluginId);
    try {
      entry.work.run(run);
    } finally {
      // This fence includes registration descendants, never the later disposal phase.
      this.#trackRegistration(entry.work.runWhenIdle(() => undefined));
    }
  }

  register(pluginId: string, disposer: RegistrationDisposer): void {
    this.#registration(pluginId).disposers.push(disposer);
  }

  trackRegistration(pending: Promise<unknown>): void {
    this.#trackRegistration(trackAsyncWork(() => pending));
  }

  #trackRegistration(pending: Promise<unknown>): void {
    const completion = pending.then(
      () => undefined,
      () => undefined,
    );
    this.#pending.add(completion);
    void completion.then(() => this.#pending.delete(completion));
  }

  rollback(pluginId: string): void {
    const entry = this.#registrations.get(pluginId);
    if (entry) {
      entry.rolledBack = true;
      void this.#dispose(pluginId, entry);
    }
  }

  async #waitForRegistrations(): Promise<void> {
    while (this.#pending.size > 0) {
      await Promise.all(this.#pending);
    }
  }

  #dispose(pluginId: string, entry: RegistrationResources): Promise<Error[]> {
    return (entry.disposal ??= Promise.resolve().then(async () => {
      entry.work.beginClose();
      // Invalid async registration can still use a successful sibling's resources.
      await this.#waitForRegistrations();
      try {
        return await AsyncWorkScope.runWhenAllIdle(
          () =>
            [...this.#registrations.values()]
              .filter((candidate) => !candidate.disposalStarted)
              .map((candidate) => candidate.work),
          () =>
            entry.work.track(async () => {
              entry.disposalStarted = true;
              const failures: Error[] = [];
              const disposers = entry.disposers.splice(0);
              for (const { id, dispose } of disposers) {
                try {
                  await dispose();
                } catch (cause) {
                  failures.push(
                    new Error(`Plugin inspection disposal failed: ${pluginId}:${id}`, { cause }),
                  );
                }
              }
              return failures;
            }),
        );
      } finally {
        // Draining inside the tracked disposal callback would wait on itself.
        await entry.work.drain();
      }
    }));
  }
}
