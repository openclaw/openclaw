/** Pre-dispatch session state changed before any user-visible work began. */
export class DispatchSessionRefreshRequiredError extends Error {
  constructor(cause: Error) {
    super(cause.message, { cause });
    this.name = "DispatchSessionRefreshRequiredError";
  }
}
