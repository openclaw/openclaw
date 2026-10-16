export class SessionCanonicalKeyMigrationRequiredError extends Error {
  readonly code = "SESSION_CANONICAL_KEY_MIGRATION_REQUIRED";
  constructor(detail: string) {
    super(`${detail}; stop the Gateway and run openclaw doctor --fix`);
    this.name = "SessionCanonicalKeyMigrationRequiredError";
  }
}
