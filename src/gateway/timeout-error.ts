/**
 * Error thrown when a gateway request times out.
 */
export class GatewayTimeoutError extends Error {
  readonly timeoutMs: number;
  readonly method: string;

  constructor(method: string, timeoutMs: number) {
    super(`Gateway request '${method}' timed out after ${timeoutMs}ms`);
    this.name = "GatewayTimeoutError";
    this.method = method;
    this.timeoutMs = timeoutMs;
  }
}
