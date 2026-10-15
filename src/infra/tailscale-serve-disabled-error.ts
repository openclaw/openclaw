/** A retired Serve command reported a tailnet policy denial. */
export class TailscaleServeDisabledError extends Error {
  constructor() {
    super("Serve is not enabled on your tailnet.");
    this.name = "TailscaleServeDisabledError";
  }
}
