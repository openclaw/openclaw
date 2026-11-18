import { resolveGlobalSingleton } from "../shared/global-singleton.js";

const sourceAcquisitionFailures = resolveGlobalSingleton(
  Symbol.for("openclaw.pluginSourceAcquisitionFailures"),
  () => new WeakSet<object>(),
);
const sourcePreparationOperations = resolveGlobalSingleton(
  Symbol.for("openclaw.pluginSourcePreparationOperations"),
  () => new WeakSet<object>(),
);

/** Preparation handles are distinct from expensive capture RPCs and executable plugin callbacks. */
export function markPluginSourcePreparationOperation<T extends object>(operation: T): T {
  sourcePreparationOperations.add(operation);
  return operation;
}

export function isPluginSourcePreparationOperation(operation: object): boolean {
  return sourcePreparationOperations.has(operation);
}

/** Only source operations mark failures; later cleanup must settle before a caller contains one. */
export function markPluginSourceAcquisitionError<T>(error: T): T {
  if (error instanceof Error) {
    sourceAcquisitionFailures.add(error);
  }
  return error;
}

export function clearPluginSourceAcquisitionError<T>(error: T): T {
  if (error instanceof Error) {
    sourceAcquisitionFailures.delete(error);
  }
  return error;
}

export function isPluginSourceAcquisitionError(error: unknown): error is Error {
  return error instanceof Error && sourceAcquisitionFailures.has(error);
}

export function createPluginSourceValidationError(message: string, originalSource = true): Error {
  const error = new Error(message);
  return originalSource ? markPluginSourceAcquisitionError(error) : error;
}

export function acquirePluginSource<T>(run: () => T, originalSource = true): T {
  try {
    return run();
  } catch (error) {
    throw originalSource
      ? markPluginSourceAcquisitionError(error)
      : clearPluginSourceAcquisitionError(error);
  }
}

/** A failed dependency link never constitutes a prepared plugin capture. */
export class PluginDependencyLinkError extends Error {
  override name = "PluginDependencyLinkError";
}

export function createPluginDependencyLinkError(name: string, rootDir: string, cause: unknown) {
  const error = new PluginDependencyLinkError(
    `Cannot prepare dependency ${name} for plugin ${rootDir}; check filesystem permissions and retry.`,
    { cause },
  );
  return isPluginSourceAcquisitionError(cause) ? markPluginSourceAcquisitionError(error) : error;
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
