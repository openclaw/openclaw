import fs from "node:fs";
import { parentPort, workerData } from "node:worker_threads";
import { walkDirectory } from "@openclaw/fs-safe/walk";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { resolveAgentPortRoots } from "../infra/database-engine/agent-port.js";
import { resolveDatabaseEngineSelection } from "../infra/database-engine/config.js";
import { withDatabaseEngineSelection } from "../infra/database-engine/context.js";
import {
  inspectDatabaseStore,
  type DatabaseStoreDiagnostic,
} from "../infra/database-engine/diagnostics.js";
import { listLocalDatabaseDiagnosticStores } from "../infra/database-engine/local-diagnostics.js";
import type { BackupEngine } from "../infra/database-engine/physical-store.js";
import { databasePortProviders } from "../infra/database-engine/port-provider.js";
import { describeDatabaseEngineSelection } from "../infra/database-engine/report.js";
import { resolveStatePortRoots } from "../infra/database-engine/state-port.js";
import type {
  DatabaseEngineFamily,
  DatabaseEngineId,
  DatabaseEngineSelection,
} from "../infra/database-engine/types.js";
import { captureRuntimeWorkerSource } from "../infra/runtime-worker-generation.js";
import { WorkerTaskPool } from "../infra/worker-task-pool.js";
import { loadBundledPluginManifestRegistry } from "../plugins/manifest-registry-build.js";
import { resolvePluginMetadataSnapshot } from "../plugins/plugin-metadata-snapshot.js";
import { withPluginSourceCaptureStorage } from "../plugins/plugin-source-capture-context.js";
import { withArtifactPreservingStateReads } from "../state/artifact-preserving-state-reads.js";
import { inspectDoctorDatabaseLegacyMigrations } from "./doctor-database-legacy-inspection.js";

type Input = { config: OpenClawConfig; stateDir: string; env: NodeJS.ProcessEnv };
export type ObservedDatabaseEngines = Partial<Record<DatabaseEngineFamily, DatabaseEngineId[]>>;
export type DoctorDatabaseEngineInspection = {
  observed: ObservedDatabaseEngines;
  stateRoots: { path: string; physical: BackupEngine }[];
  discoveryFailed: boolean;
  stores?: DatabaseStoreDiagnostic[];
};

/** Operator-only inspection. Never installed in a Gateway request or database hot path. */
export async function inspectDoctorDatabaseEngines(
  input: Input,
): Promise<DoctorDatabaseEngineInspection> {
  const pool = new WorkerTaskPool<Input, DoctorDatabaseEngineInspection>({
    workerUrl: captureRuntimeWorkerSource(new URL(import.meta.url)).moduleUrl,
    maxWorkers: 1,
    workerOptions: { workerData: { doctorDatabaseEngines: true } },
  });
  try {
    return await pool.run(input, {});
  } finally {
    await pool.close();
  }
}

if (parentPort && workerData?.doctorDatabaseEngines === true) {
  const { serveWorkerTasks } = await import("../infra/worker-task-server.js");
  serveWorkerTasks<DoctorDatabaseEngineInspection>(async (value) => {
    // SAFETY: The Doctor host supplies this private, serializable input.
    const input = value as Input;
    const env = { ...input.env, OPENCLAW_STATE_DIR: input.stateDir };
    const stores: DatabaseStoreDiagnostic[] = [];
    const result: DoctorDatabaseEngineInspection = {
      observed: {},
      stateRoots: [],
      discoveryFailed: false,
      stores,
    };
    let selection: DatabaseEngineSelection | undefined;
    try {
      selection = await resolveDatabaseEngineSelection(input.config, env);
    } catch {
      result.discoveryFailed = true;
    }
    const inspect = async () => {
      let plugins: Pick<ReturnType<typeof resolvePluginMetadataSnapshot>, "plugins">;
      try {
        plugins = resolvePluginMetadataSnapshot({ ...input, env });
      } catch {
        // Bundled resource descriptors still locate retained Matrix/plugin roots when PG is down.
        result.discoveryFailed = true;
        try {
          plugins = loadBundledPluginManifestRegistry({ env });
        } catch {
          plugins = { plugins: [] };
        }
      }
      const legacy = await inspectDoctorDatabaseLegacyMigrations({ ...input, env });
      const inspected = new Set<string>();
      for (const family of describeDatabaseEngineSelection(input.config)) {
        const provider = databasePortProviders.find((entry) => entry.id === family.id);
        if (!provider) {
          continue;
        }
        let roots: readonly string[];
        try {
          roots = await provider.resolveRoots({ ...input, env, plugins });
        } catch {
          result.discoveryFailed = true;
          roots =
            family.id === "state"
              ? resolveStatePortRoots(input)
              : family.id === "agent"
                ? await resolveAgentPortRoots({ ...input, env }, [])
                : [];
        }
        const files = new Set<string>();
        const unreadableRoots = new Set<string>();
        let hasPhysicalStore = false;
        for (const root of roots) {
          try {
            const stat = fs.statSync(root, { throwIfNoEntry: false });
            if (stat?.isFile()) {
              files.add(fs.realpathSync(root));
              hasPhysicalStore = true;
            } else if (!stat && root.endsWith(".sqlite")) {
              files.add(root);
            } else if (stat?.isDirectory()) {
              const walked = await walkDirectory(root, {
                symlinks: "include",
                include: (entry) =>
                  (entry.kind === "file" || entry.kind === "symlink") &&
                  entry.path.endsWith(".sqlite"),
              });
              if (walked.failedDirs.length) {
                result.discoveryFailed = true;
                for (const failure of walked.failedDirs) {
                  files.add(failure.path);
                  unreadableRoots.add(failure.path);
                }
              }
              for (const entry of walked.entries) {
                try {
                  files.add(fs.realpathSync(entry.path));
                  hasPhysicalStore = true;
                } catch {
                  result.discoveryFailed = true;
                  files.add(entry.path);
                  unreadableRoots.add(entry.path);
                }
              }
            }
          } catch {
            result.discoveryFailed = true;
            files.add(root);
            unreadableRoots.add(root);
          }
        }
        let descriptor;
        // Absent optional stores need no port API or plugin runtime to inspect.
        if (hasPhysicalStore) {
          try {
            descriptor = await provider.loadDescriptor(
              plugins.plugins.find((plugin) => plugin.id === provider.id),
            );
          } catch {
            result.discoveryFailed = true;
          }
        }
        for (const file of files.size ? [...files].toSorted() : [null]) {
          if (file && inspected.has(file)) {
            continue;
          }
          if (file) {
            inspected.add(file);
          }
          const diagnostic = await inspectDatabaseStore({
            family: family.id,
            path: file,
            configured: {
              default: family.default,
              override: family.override,
              effective: family.effective,
              fixedLocal: family.fixedLocal,
            },
            descriptor,
            postgres: selection?.postgres,
            inspectionError: file && unreadableRoots.has(file) ? "unreadable-root" : undefined,
          });
          diagnostic.legacyMigrations = legacy[family.id] ?? { state: "unknown", pending: [] };
          if (diagnostic.legacyMigrations.state !== "none") {
            diagnostic.nextSteps.push(
              "Run openclaw doctor --fix before database port; enable any named disabled plugin for repair.",
            );
          }
          stores.push(diagnostic);
          if (diagnostic.observed !== "unknown") {
            const engines = (result.observed[family.id] ??= []);
            if (!engines.includes(diagnostic.observed)) {
              engines.push(diagnostic.observed);
            }
          }
          // Retain the old shape for callers that consume precise state mismatch findings.
          if (family.id === "state" && file && diagnostic.observed !== "unknown") {
            const physical: BackupEngine =
              diagnostic.observed === "sqlite"
                ? { engine: "sqlite" }
                : {
                    engine: "postgres",
                    namespace: diagnostic.namespace!,
                    storeId: diagnostic.storeId!,
                  };
            result.stateRoots.push({ path: file, physical });
          }
        }
      }
      for (const local of listLocalDatabaseDiagnosticStores()) {
        let file: string | null = null;
        try {
          file = await local.resolvePath(env);
        } catch {
          result.discoveryFailed = true;
        }
        stores.push(
          await inspectDatabaseStore({
            family: local.id,
            path: file,
            schemaVersion: local.resolveSchemaVersion ? await local.resolveSchemaVersion() : null,
            configured: {
              default: input.config.database?.engine ?? "sqlite",
              override: null,
              effective: "sqlite",
              fixedLocal: true,
            },
          }),
        );
      }
    };
    // The caller's inspection context does not cross this worker boundary.
    await withPluginSourceCaptureStorage({ stateDir: input.stateDir, placement: "temporary" }, () =>
      withArtifactPreservingStateReads(
        () => (selection ? withDatabaseEngineSelection(selection, inspect) : inspect()),
        { agentDatabases: true },
      ),
    );
    return result;
  });
}
