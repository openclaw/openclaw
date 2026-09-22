import { resolveGlobalSingleton } from "../shared/global-singleton.js";

/** A retired instance cannot admit a fresh invocation. */
export class PluginInstanceUnavailableError extends Error {
  constructor(pluginId?: string) {
    super(
      pluginId
        ? `Plugin ${pluginId} was reloaded or disabled; use its current tools.`
        : "Plugin tools changed during automation setup; use the current plugin runtime.",
    );
    this.name = "PluginInstanceUnavailableError";
  }
}

// Source Gateway owners and compiled SDK instances share this diagnostic identity.
export const PluginInstanceDrainTimeoutError = resolveGlobalSingleton(
  Symbol.for("openclaw.pluginInstanceDrainTimeoutError"),
  () =>
    class DrainTimeoutError extends Error {
      constructor(
        message: string,
        readonly settled: Promise<void>,
        options: ErrorOptions,
      ) {
        super(message, options);
        this.name = "PluginInstanceDrainTimeoutError";
      }
    },
);

export type PluginInstanceDrainTimeoutError = InstanceType<typeof PluginInstanceDrainTimeoutError>;
