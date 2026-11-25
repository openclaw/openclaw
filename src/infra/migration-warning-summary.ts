export const MIGRATION_WARNING_EXAMPLE_LIMIT = 5;

export function formatMigrationWarningSummary(params: {
  summary: string;
  count: number;
  detail: string;
}): string {
  const shown = Math.min(params.count, MIGRATION_WARNING_EXAMPLE_LIMIT);
  return (
    `${params.summary}; showing ${shown} example(s), ${params.count - shown} omitted. ` +
    params.detail
  );
}
