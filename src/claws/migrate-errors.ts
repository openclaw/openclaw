export class ClawMigrationError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly path = "$",
  ) {
    super(message);
    this.name = "ClawMigrationError";
  }
}
