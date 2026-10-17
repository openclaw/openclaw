/** Prepared state lost authority before the next external effect began. */
export class PluginStateOperationInvalidatedError extends Error {
  constructor() {
    super("Plugin state operation receipt is no longer current");
    this.name = "PluginStateOperationInvalidatedError";
  }
}
