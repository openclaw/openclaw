export class GatewaySessionFactsChangedDuringReadError extends Error {
  constructor() {
    super("Session sharing facts changed during read");
    this.name = "GatewaySessionFactsChangedDuringReadError";
  }
}
