import { terminalText } from "../../packages/terminal-core/src/safe-text.js";
import type { BackupManifest } from "./backup-verify-manifest.js";
import type { verifyBackupArchive } from "./backup-verify.js";

export function backupRecoveryInventory({ assets, sqliteSnapshots }: BackupManifest) {
  return {
    assetKinds: [...new Set(assets.map((asset) => asset.kind))],
    sqliteSnapshots:
      sqliteSnapshots?.map((snapshot) =>
        snapshot.role === "agent"
          ? { role: snapshot.role, agentId: snapshot.agentId }
          : { role: snapshot.role },
      ) ?? null,
  };
}

export type BackupVerifyResult = Awaited<ReturnType<typeof verifyBackupArchive>> & {
  inventory?: ReturnType<typeof backupRecoveryInventory>;
};

export function formatBackupVerifyResult(result: BackupVerifyResult): string {
  const lines = [
    terminalText`Backup archive OK: ${result.archivePath}`,
    terminalText`Archive root: ${result.archiveRoot}`,
    terminalText`Created at: ${result.createdAt}`,
    terminalText`Runtime version: ${result.runtimeVersion}`,
    terminalText`Assets verified: ${result.assetCount}`,
    terminalText`Archive entries scanned: ${result.entryCount}`,
    terminalText`Symbolic links checked: ${result.symlinkCount}`,
    result.sqliteInventoryVerified
      ? "SQLite database inventory verified."
      : "SQLite database coverage unknown: this legacy archive has no database inventory.",
  ];
  if (result.inventory) {
    const { assetKinds, sqliteSnapshots } = result.inventory;
    lines.push(terminalText`Asset kinds: ${assetKinds.join(", ") || "none"}`);
    if (sqliteSnapshots !== null) {
      const owners = sqliteSnapshots.map((db) =>
        db.role === "global" ? "global" : `agent (${db.agentId})`,
      );
      lines.push(terminalText`SQLite snapshots: ${owners.join(", ") || "none"}`);
    }
  }
  return [...lines, ...(result.warnings ?? []).map((warning) => terminalText`${warning}`)].join(
    "\n",
  );
}
