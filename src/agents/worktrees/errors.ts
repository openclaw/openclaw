export class WorktreeRepositoryError extends Error {
  readonly reason?: "unborn";

  constructor(message: string, options?: ErrorOptions & { reason?: "unborn" }) {
    super(message, options);
    this.name = "WorktreeRepositoryError";
    this.reason = options?.reason;
  }
}
