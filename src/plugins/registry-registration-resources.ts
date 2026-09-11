import { AsyncWorkScope, trackAsyncWork } from "../shared/async-work-scope.js";
import { PluginRuntimeCloseRetainedError } from "./runtime-close-error.js";

export type RegistrationDisposer = { id: string; dispose: () => void | Promise<void> };
export type RegistrationCleanup = (run: () => Promise<void>) => Promise<void>;
type RegistrationResources = {
  disposers: RegistrationDisposer[];
  work: AsyncWorkScope;
  runCleanup?: RegistrationCleanup;
  rolledBack?: boolean;
  disposal?: Promise<Error[]>;
  disposalStarted?: boolean;
  retire?: () => Promise<void>;
};

/** Physical registration custody, independent of registry execution authority. */
export class PluginRegistrationResourceSource {
  readonly #registrations = new Map<string, RegistrationResources>();
  readonly #pending = new Set<Promise<void>>();
  readonly #dependencies: Array<() => Promise<void>> = [];
  #claims = 0;
  #closed = false;

  constructor(private readonly retire: () => Promise<void>) {}

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
            // Queue the whole batch before any signal's awaited cleanup can reach disposal.
            const disposals = entries.map(([pluginId, entry]) => this.#dispose(pluginId, entry));
            await this.#waitForRegistrations();
            const outcomes = await Promise.allSettled(disposals);
            // Callback faults resolve as rows; rejection leaves a cleanup prerequisite unfinished.
            const failures = outcomes.flatMap((outcome) =>
              outcome.status === "fulfilled"
                ? outcome.value
                : [new PluginRuntimeCloseRetainedError(outcome.reason)],
            );
            if (last) {
              // Rollback errors belong to construction; join its work before
              // the final physical claim retires the shared instances and cache.
              await Promise.allSettled(
                [...this.#registrations].map(([pluginId, entry]) => this.#dispose(pluginId, entry)),
              );
              try {
                await this.retire();
              } catch (error) {
                failures.push(
                  error instanceof Error
                    ? error
                    : new Error("Plugin inspection cleanup failed", { cause: error }),
                );
              } finally {
                await Promise.all(
                  [...this.#registrations.values()].map(({ work }) => work.drain()),
                );
              }
              // Final instance cleanup can still use copied callbacks from these donors.
              for (const releaseDependency of this.#dependencies.splice(0)) {
                try {
                  await releaseDependency();
                } catch (cause) {
                  failures.push(
                    new Error("Borrowed plugin registration resources could not be disposed", {
                      cause,
                    }),
                  );
                }
              }
            }
            return failures;
          });
        }
        return release;
      },
    };
  }

  /** Acquires custody before publication and relinquishes it after final physical disposal. */
  retainDependency(acquire: () => { release: () => Promise<void> }): void {
    if (this.#closed) {
      throw new Error("Plugin registration resources have been released");
    }
    this.#dependencies.push(acquire().release);
  }

  #registration(pluginId: string): RegistrationResources {
    let entry = this.#registrations.get(pluginId);
    if (!entry) {
      entry = { disposers: [], work: new AsyncWorkScope() };
      this.#registrations.set(pluginId, entry);
    }
    return entry;
  }

  runRegistration(pluginId: string, run: () => void, runCleanup?: RegistrationCleanup): void {
    const entry = this.#registration(pluginId);
    entry.runCleanup ??= runCleanup;
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

  rollback(pluginId: string, retire?: () => Promise<void>): void {
    const entry = this.#registration(pluginId);
    entry.rolledBack = true;
    entry.retire ??= retire;
    void this.#dispose(pluginId, entry);
  }

  async #waitForRegistrations(): Promise<void> {
    while (this.#pending.size > 0) {
      await Promise.all(this.#pending);
    }
  }

  #pendingWork(): AsyncWorkScope[] {
    return [...this.#registrations.values()]
      .filter((entry) => !entry.disposalStarted)
      .map((entry) => entry.work);
  }

  #dispose(pluginId: string, entry: RegistrationResources): Promise<Error[]> {
    return (entry.disposal ??= Promise.resolve().then(async () => {
      const signalCleanup = async () => {
        entry.work.beginClose();
        // Abort listeners can queue work in a sibling. Keep this cleanup admission
        // until those descendants join, before any registration resource is disposed.
        await this.#waitForRegistrations();
        await AsyncWorkScope.runWhenAllIdle(
          () => this.#pendingWork(),
          () => undefined,
        );
      };
      await (entry.runCleanup ? entry.runCleanup(signalCleanup) : signalCleanup());
      const failures: Error[] = [];
      try {
        await AsyncWorkScope.runWhenAllIdle(
          () => this.#pendingWork(),
          () =>
            entry.work.track(async () => {
              entry.disposalStarted = true;
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
            }),
        );
        try {
          // Instance cleanup can use the same captured tracker as raw disposal.
          await entry.work.runWhenIdle(() => entry.retire?.());
        } catch (cause) {
          failures.push(new Error(`Plugin inspection retirement failed: ${pluginId}`, { cause }));
        }
        return failures;
      } finally {
        // Rollback owns its final drain. Successful instances remain owned by the
        // last physical claim, so their captured cleanup scope must stay usable.
        if (entry.rolledBack) {
          await entry.work.drain();
        } else {
          await entry.work.runWhenIdle(() => undefined);
        }
      }
    }));
  }
}
