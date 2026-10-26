/** Imports and receipts keep the original name across an interrupted cleanup claim. */
export function resolveLegacyMigrationSourcePath(filePath: string): string {
  return filePath.replace(
    /\.doctor-importing(?:-\d+-[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12})?$/,
    "",
  );
}
