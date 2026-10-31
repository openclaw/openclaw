/** A removed plugin capability remains diagnosable without preserving its authority. */
export class PluginCapabilityRemovedError extends Error {
  readonly code = "PLUGIN_CAPABILITY_REMOVED";

  constructor(
    readonly capability: string,
    replacement: string,
  ) {
    super(`${capability} was removed. ${replacement}`);
    this.name = "PluginCapabilityRemovedError";
  }
}

export function removedPluginCapabilityDescriptor(
  capability: string,
  replacement: string,
): PropertyDescriptor {
  const reject = () => {
    throw new PluginCapabilityRemovedError(capability, replacement);
  };
  return { get: reject, set: reject, enumerable: false, configurable: false };
}
