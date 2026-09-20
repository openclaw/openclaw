import { migrateLegacyDevicePairingStore } from "./device-pairing-migration.js";
import { migrateLegacyNodePairingStore } from "./node-pairing-migration.js";
import { listLegacyPairingStoreFiles } from "./pairing-files.js";
import { withLegacyMigrationStateLock } from "./state-migrations.lock.js";

export async function migrateDoctorPairingStores(params: {
  stateDir: string;
  env: NodeJS.ProcessEnv;
}) {
  if ((await listLegacyPairingStoreFiles(params.stateDir)).length === 0) {
    return { changes: [], warnings: [] };
  }
  return withLegacyMigrationStateLock({
    ...params,
    label: "legacy pairing stores",
    releaseLabel: "Pairing store",
    run: async () => {
      const changes: string[] = [];
      const warnings: string[] = [];
      const log = {
        info: (message: string) => changes.push(message),
        warn: (message: string) => warnings.push(message),
      };
      // The node fold must see imported device approvals before classifying orphan rows.
      await migrateLegacyDevicePairingStore({ baseDir: params.stateDir, log });
      await migrateLegacyNodePairingStore({ baseDir: params.stateDir, log });
      return { changes, warnings, warningDisposition: "recoverable" };
    },
  });
}
