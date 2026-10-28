export function createSqlStatementObserver(
  matches: (sql: string) => boolean,
  onMatch: () => void,
): (event: unknown) => void {
  return (event: unknown) => {
    if (
      event &&
      typeof event === "object" &&
      "sql" in event &&
      typeof event.sql === "string" &&
      matches(event.sql)
    ) {
      onMatch();
    }
  };
}
