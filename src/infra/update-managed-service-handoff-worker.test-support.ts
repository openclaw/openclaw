import type { prepareManagedHandoffParentStore } from "./update-managed-service-handoff-worker.js";

/** In-process lifecycle fixtures inject fake PIDs; real-process cases use the actual worker. */
export const prepareManagedHandoffParentStoreForTest: typeof prepareManagedHandoffParentStore =
  async (options) => {
    const { assertManagedUpdateLeaseDatabaseIdentity, prepareManagedHandoffLeaseDatabaseIdentity } =
      await import("./update-managed-service-handoff-database.js");
    const { prepareManagedHandoffLeaseStore, resolveManagedUpdateLeaseDatabasePath } =
      await import("./update-managed-service-handoff-lease.js");
    const {
      assertLegacyGatewayCustodySettled,
      resolveLegacyGatewayManagedUpdateLeaseDatabasePath,
    } = await import("./update-managed-service-handoff-legacy-store.js");
    const databaseIdentity =
      options.existingIdentity ??
      (await prepareManagedHandoffLeaseDatabaseIdentity(
        options.databasePath ?? resolveManagedUpdateLeaseDatabasePath(),
      ));
    const store = await prepareManagedHandoffLeaseStore({
      ...options,
      databasePath: databaseIdentity.databasePath,
      existingIdentity: databaseIdentity,
    });
    return {
      databaseIdentity,
      close: async () => {},
      stageRuntime: async (directory) => {
        const { stageManagedHandoffRuntime } =
          await import("./update-managed-service-handoff-runtime.js");
        return stageManagedHandoffRuntime(directory);
      },
      assertCurrent: async () => {
        await assertLegacyGatewayCustodySettled(
          options.installRoot,
          resolveLegacyGatewayManagedUpdateLeaseDatabasePath(databaseIdentity.databasePath),
        );
        assertManagedUpdateLeaseDatabaseIdentity(databaseIdentity);
      },
      read: async (...args) => store.read(...args),
      release: async (...args) => store.release(...args),
      stopNative: async (...args) => store.stopNative(...args),
      processIdentity: async (...args) => store.processIdentity(...args),
      isProcessIdentityCurrent: async (...args) => store.isProcessIdentityCurrent(...args),
      inspectProcessIdentity: async (...args) => store.inspectProcessIdentity(...args),
    };
  };
