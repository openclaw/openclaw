export class ClawMigrationError extends Error {
  readonly path = "$.agents.defaults";

  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "ClawMigrationError";
  }
}
