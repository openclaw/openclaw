import type { SqliteWorkerCommand } from "./sqlite-worker-contract.js";
import type { LegacyMigrationReceipt } from "./state-migrations.receipts.js";

/** Prepared under the original Doctor source claim before worker dispatch. */
export type PreparedLegacyMcpOAuthImport = {
  sourceKey: string;
  sourcePath: string;
  storeKey: string;
  sourceSha256: string;
  sourceSizeBytes: number;
  store: Record<string, unknown>;
  now: number;
};

export type LegacyMcpOAuthImportResult = { sourceKey: string; imported: boolean };

export type LegacyMcpOAuthWorkerOperations = {
  "legacyMcpOAuth.readReceipt": {
    input: { sourceKey: string };
    output: LegacyMigrationReceipt | null;
  };
  "legacyMcpOAuth.import": {
    input: PreparedLegacyMcpOAuthImport;
    output: LegacyMcpOAuthImportResult;
  };
  "legacyMcpOAuth.markRemoved": { input: { sourceKey: string }; output: void };
};

export function isLegacyMcpOAuthWorkerCommand(command: {
  type: string;
  input: unknown;
}): command is SqliteWorkerCommand<LegacyMcpOAuthWorkerOperations> {
  return (
    command.type === "legacyMcpOAuth.readReceipt" ||
    command.type === "legacyMcpOAuth.import" ||
    command.type === "legacyMcpOAuth.markRemoved"
  );
}
