import { resolveQuarantineStorePath } from "../../state/openclaw-state-db.paths.js";
import { listDatabaseEngineStores } from "./registry.js";
import type { DatabaseEngineFamily } from "./types.js";

type DiagnosticOwner = {
  resolvePath: (env: NodeJS.ProcessEnv) => Promise<string | null>;
  resolveSchemaVersion?: () => Promise<number>;
};

// Keep operator-only owners out of the registry used by every SQLite worker.
const owners: Partial<Record<DatabaseEngineFamily, DiagnosticOwner>> = {
  quarantine: {
    async resolveSchemaVersion() {
      const { OPENCLAW_QUARANTINE_SCHEMA_VERSION } =
        await import("../../state/openclaw-quarantine-store.js");
      return OPENCLAW_QUARANTINE_SCHEMA_VERSION;
    },
    async resolvePath(env) {
      return resolveQuarantineStorePath(env);
    },
  },
  "managed-update": {
    async resolvePath() {
      const { resolveManagedUpdateLeaseDatabasePath } =
        await import("../update-managed-service-handoff-lease.js");
      return resolveManagedUpdateLeaseDatabasePath();
    },
  },
  "package-activation": {
    async resolvePath() {
      const { resolveOpenClawPackageRoot } = await import("../openclaw-root.js");
      const { resolvePackageActivationAnchor, resolvePackageActivationJournalPath } =
        await import("../package-update-activation-paths.js");
      const root = await resolveOpenClawPackageRoot({ moduleUrl: import.meta.url });
      return root
        ? resolvePackageActivationJournalPath(resolvePackageActivationAnchor(root))
        : null;
    },
  },
};

/** The registry owns enumeration; credentials are intentionally not configurable. */
export function listLocalDatabaseDiagnosticStores() {
  return [
    ...listDatabaseEngineStores()
      .filter((store) => !store.postgres)
      .map((store) => {
        const owner = owners[store.id];
        if (!owner) {
          throw new Error(`No database diagnostics owner for ${store.id}`);
        }
        return {
          id: store.id,
          label: store.label,
          resolvePath: owner.resolvePath,
          resolveSchemaVersion: owner.resolveSchemaVersion,
        };
      }),
    {
      id: "credentials",
      label: "Local credentials",
      async resolveSchemaVersion() {
        const { CLIENT_CREDENTIAL_SCHEMA_VERSION } = await import("../client-credential-schema.js");
        return CLIENT_CREDENTIAL_SCHEMA_VERSION;
      },
      async resolvePath(env: NodeJS.ProcessEnv) {
        const { resolveClientCredentialStorePath } = await import("../client-credential-store.js");
        return resolveClientCredentialStorePath(env);
      },
    },
  ];
}
