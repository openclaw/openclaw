export class SessionMetadataUnavailableError extends Error {
  constructor(
    readonly reason: "schema-missing" | "table-missing",
    options?: ErrorOptions,
    readonly missingTables: readonly string[] = [],
  ) {
    super(
      `Session metadata unavailable (${[reason, ...missingTables].join(": ")}); retry after the agent store is ready.`,
      options,
    );
    this.name = "SessionMetadataUnavailableError";
  }
}
