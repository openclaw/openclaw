export type RegistrationDisposer = { id: string; dispose: () => void | Promise<void> };
type RegistrationResources = {
  disposers: RegistrationDisposer[];
  rolledBack?: boolean;
  disposal?: Promise<Error[]>;
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
            await this.#waitForRegistrations();
            const results = await Promise.all(
              [...this.#registrations]
                // Construction owns rollback failures; the last claim owns successful entries.
                .filter(([, entry]) => (entry.rolledBack ? owner === "inspection" : last))
                .map(([pluginId, entry]) => this.#dispose(pluginId, entry)),
            );
            return results.flat();
          });
        }
        return release;
      },
    };
  }

  register(pluginId: string, disposer: RegistrationDisposer): void {
    let entry = this.#registrations.get(pluginId);
    if (!entry) {
      entry = { disposers: [] };
      this.#registrations.set(pluginId, entry);
    }
    entry.disposers.push(disposer);
  }

  trackRegistration(pending: Promise<unknown>): void {
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
      // Invalid async registration can still use a successful sibling's resources.
      await this.#waitForRegistrations();
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
    }));
  }
}
