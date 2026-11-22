// Offline check: use the metadata-only `plugins list` loader, not a Gateway invocation.
// Tool construction requires admitted invocation authority and canonical-schema state
// (tool-resolution.ts and tool-construction-preparation.ts). It runs only at boot;
// the supervised trial catches a release whose Gateway cannot start.
import fs from "node:fs/promises";
import path from "node:path";
import { quietPluginJsonLogger } from "../cli/plugins-json-logger.js";
import {
  normalizeConfigIoDeps,
  parseConfigJson5,
  readConfigFileIfPresent,
  resolveConfigForRead,
  resolveConfigIncludesForRead,
  resolveConfigPathForDeps,
} from "../config/io.read-helpers.js";
import { resolveStateDir } from "../config/paths.js";
import { validateConfigObjectRaw } from "../config/validation-core.js";
import { hasErrnoCode } from "../infra/errno.js";
import { formatErrorMessage } from "../infra/errors.js";
import { openNodeSqliteDatabase, resolveReadOnlyShmSqliteFileUri } from "../infra/node-sqlite.js";
import { readSqliteUserVersion } from "../infra/sqlite-user-version.js";
import { collectRegisteredPaths } from "../infra/update-candidate-state.shared.js";
import { prepareBundledDiscoveryMode } from "../plugins/bundled-discovery-state.js";
import { getPersistedInstalledPluginIndexCacheEntry } from "../plugins/installed-plugin-index-record-state.js";
import { createPluginCache, withPluginCache } from "../plugins/plugin-cache.js";
import {
  readPluginMetadataStateRowsInDatabase,
  type PluginMetadataStateRow,
} from "../plugins/plugin-metadata-state.kernel.js";
import { buildPluginRegistrySnapshotReport } from "../plugins/status-snapshot.js";
import { withArtifactPreservingStateReads } from "../state/artifact-preserving-state-reads.js";
import {
  OPENCLAW_AGENT_SCHEMA_VERSION,
  OPENCLAW_STATE_SCHEMA_VERSION,
} from "../state/openclaw-schema-versions.js";
import { resolveOpenClawStateSqlitePath } from "../state/openclaw-state-db.paths.js";
import { listStateDatabases } from "./preflight.js";

export type ReleaseSurface = { plugin: string; surface: string; error?: string };
export type CheckReleaseResult = { ok: boolean; reason?: string; surfaces: ReleaseSurface[] };

/** No canonical state open: even a valid older schema must pass without migration. */
export async function checkRelease(
  options: {
    env?: NodeJS.ProcessEnv;
    configPath?: string;
  } = {},
): Promise<CheckReleaseResult> {
  const env = { ...(options.env ?? process.env) };
  const surfaces: ReleaseSurface[] = [];
  const refuse = (reason: string): CheckReleaseResult => ({ ok: false, reason, surfaces });
  try {
    const stateDir = resolveStateDir(env);
    const statePath = resolveOpenClawStateSqlitePath(env);
    const agentPaths = new Set(
      (await listStateDatabases(stateDir)).filter(
        (file) => path.basename(file) === "openclaw-agent.sqlite",
      ),
    );
    let metadataRows: PluginMetadataStateRow[] = [];
    const inspect = async (file: string, kind: "state" | "agent") => {
      try {
        await fs.access(file);
      } catch (error) {
        if (hasErrnoCode(error, "ENOENT")) {
          return;
        }
        throw error;
      }
      // readonly_shm retains committed WAL changes without modifying source sidecars.
      const db = openNodeSqliteDatabase(resolveReadOnlyShmSqliteFileUri(file), {
        readOnly: true,
        timeout: 5000,
      });
      try {
        const version = readSqliteUserVersion(db);
        const supported =
          kind === "state" ? OPENCLAW_STATE_SCHEMA_VERSION : OPENCLAW_AGENT_SCHEMA_VERSION;
        if (version > supported) {
          throw new Error(
            `${kind}-schema-newer: on-disk schema ${version} is newer than this build's ${supported}`,
          );
        }
        if (kind === "state") {
          metadataRows = readPluginMetadataStateRowsInDatabase(db, [
            "plugins.installedIndex",
            "plugins.bundledDiscovery",
          ]);
          // The update inspection owner reads registries of any schema age, read-only.
          for (const { source } of collectRegisteredPaths(db, statePath, new Map())) {
            agentPaths.add(source);
          }
        }
      } finally {
        db.close();
      }
    };
    await inspect(statePath, "state");
    for (const file of agentPaths) {
      await inspect(file, "agent");
    }
    const deps = normalizeConfigIoDeps({ env, configPath: options.configPath, observe: false });
    const configPath = resolveConfigPathForDeps(deps);
    const parsed = parseConfigJson5(readConfigFileIfPresent(deps, configPath) ?? "{}");
    if (!parsed.ok) {
      return refuse(`config-invalid: ${parsed.error}`);
    }
    const included = resolveConfigIncludesForRead(parsed.parsed, configPath, deps);
    const { resolvedConfigRaw } = resolveConfigForRead(included, env);
    const validated = validateConfigObjectRaw(resolvedConfigRaw, { env });
    if (!validated.ok) {
      return refuse(
        `config-invalid: ${validated.issues.map((issue) => `${issue.path}: ${issue.message}`).join("; ")}`,
      );
    }
    const config = validated.config;
    return await withPluginCache(createPluginCache(), async () => {
      // Feed the production inventory owner its existing metadata, read directly above.
      // Its normal state reader enforces today's schema and would reject an upgrade
      // from an older schema before boot has had an opportunity to migrate it.
      const activateDiscovery = await prepareBundledDiscoveryMode(env, async () =>
        metadataRows.find((row) => row.state_key === "plugins.bundledDiscovery"),
      );
      activateDiscovery();
      getPersistedInstalledPluginIndexCacheEntry({ env }, () =>
        metadataRows.find((row) => row.state_key === "plugins.installedIndex"),
      );
      return withArtifactPreservingStateReads(() => {
        const report = buildPluginRegistrySnapshotReport({
          config,
          env,
          logger: quietPluginJsonLogger,
        });
        for (const plugin of report.plugins) {
          surfaces.push({
            plugin: plugin.id,
            surface: "manifest",
            ...(plugin.error ? { error: plugin.error } : {}),
          });
        }
        for (const diagnostic of [...report.diagnostics, ...report.registryDiagnostics]) {
          if (diagnostic.level === "error") {
            surfaces.push({
              plugin: diagnostic.pluginId ?? "core",
              surface: "inventory",
              error: diagnostic.message,
            });
          }
        }
        const coreError = surfaces.find((surface) => surface.plugin === "core" && surface.error);
        return coreError ? refuse(coreError.error!) : { ok: true, surfaces };
      });
    });
  } catch (error) {
    return refuse(formatErrorMessage(error));
  }
}
