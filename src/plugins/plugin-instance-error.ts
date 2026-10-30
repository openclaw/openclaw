import { resolveGlobalSingleton } from "../shared/global-singleton.js";

/** A failed dependency link never constitutes a prepared plugin capture. */
export class PluginDependencyLinkError extends Error {
  override name = "PluginDependencyLinkError";
}

/** A retired instance cannot admit a fresh invocation. */
export class PluginInstanceUnavailableError extends Error {
  /**
   * @param replacement Settles when the reload that refused this fresh host call
   * finishes; absent when waiting could join the reload's own drain.
   */
  constructor(
    pluginId: string,
    readonly replacement?: Promise<void>,
  ) {
    super(`Plugin ${pluginId} was reloaded or disabled; use its current tools.`);
    this.name = "PluginInstanceUnavailableError";
  }
}

/** A retired plugin inventory cannot admit new work; callers start a fresh plugin operation. */
export const PluginInventoryRetiredError = resolveGlobalSingleton(
  Symbol.for("openclaw.pluginInventoryRetiredError"),
  () =>
    class InventoryRetiredError extends Error {
      constructor() {
        super("Plugin inventory has retired; begin a new plugin operation.");
        this.name = "PluginInventoryRetiredError";
      }
    },
);

export const PluginSourceRecoveryUnavailableError = resolveGlobalSingleton(
  Symbol.for("openclaw.pluginSourceRecoveryUnavailableError"),
  () =>
    class SourceRecoveryUnavailableError extends Error {
      constructor(cause: unknown) {
        super("Captured plugin source is missing; its previous code cannot be recovered.", {
          cause,
        });
        this.name = "PluginSourceRecoveryUnavailableError";
      }
    },
);

// Source Gateway owners and compiled SDK instances share this diagnostic identity.
export const PluginInstanceDrainTimeoutError = resolveGlobalSingleton(
  Symbol.for("openclaw.pluginInstanceDrainTimeoutError"),
  () =>
    class DrainTimeoutError extends Error {
      constructor(
        message: string,
        readonly settled: Promise<void>,
        options: ErrorOptions,
        readonly forcedRetirement?: {
          activeCallCount: number;
          retainedConsumerCount: number;
        },
      ) {
        super(message, options);
        this.name = "PluginInstanceDrainTimeoutError";
      }
    },
);

export type PluginInstanceDrainTimeoutError = InstanceType<typeof PluginInstanceDrainTimeoutError>;
