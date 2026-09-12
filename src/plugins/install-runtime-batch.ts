import fs from "node:fs";
import { safeParseJson } from "@openclaw/normalization-core/json-coercion";
import { asRecord } from "@openclaw/normalization-core/record-coerce";
import { readCurrentConfigForPolicyCheck } from "../config/io.runtime.js";
import type { ConfigReplaceResult } from "../config/mutate.js";
import { formatErrorMessage } from "../infra/errors.js";
import type { OpenClawStateDatabaseOptions } from "../state/openclaw-state-db.js";
import { hashStableJson } from "./installed-plugin-index-hash.js";
import { resolveInstalledPluginIndexInstallOwner } from "./installed-plugin-index-install-owner.js";
import { readPersistedInstalledPluginIndexRowSync } from "./installed-plugin-index-row.js";
import type { InstalledPluginIndexWriteReceipt } from "./installed-plugin-index-store-write.js";
import { parseInstalledPluginIndex } from "./installed-plugin-index-store.js";
import { createInstalledPluginOwnershipResolver } from "./installed-plugin-package-ownership.js";
import type { PluginRuntimeApplication } from "./lifecycle.js";
import { inspectPluginGenerationSources } from "./plugin-generation-source-inspection.js";
import {
  hasPluginLifecycleLease,
  withPluginLifecycleLease,
  type PluginLifecycleLeaseContext,
} from "./plugin-lifecycle-lease.js";

export type PluginInstallRuntimeCommit = {
  pluginId: string;
  write: InstalledPluginIndexWriteReceipt & { configWrite: ConfigReplaceResult };
} & ({ operation: "install"; sourceDigests: Record<string, string> } | { operation: "uninstall" });

export type PluginInstallRuntimeDeferral = {
  record(commit: PluginInstallRuntimeCommit, assertSourceCurrent?: () => void): void;
  deferCleanup(cleanup: PluginSourceCleanup, sourcePath: string): void;
};

type PluginSourceCleanup = (
  assertOwned: () => void,
  warn: (message: string) => void,
) => Promise<void>;

export type PluginInstallBatchTarget = {
  pluginId: string;
  installHash: string;
  sourceDigests?: Record<string, string>;
};
export type PluginInstallBatchReload = (
  plugins: readonly PluginInstallBatchTarget[],
) => Promise<PluginRuntimeApplication>;

function indexFromRow(value: string | undefined) {
  if (value === undefined) {
    return undefined;
  }
  const index = parseInstalledPluginIndex(asRecord(safeParseJson(value))?.index);
  if (!index) {
    throw new Error("Plugin batch has an invalid installed-index receipt");
  }
  return index;
}

/** Owns ephemeral committed facts and cleanup across the CLI-to-Gateway lease gap. */
export class PluginInstallRuntimeBatch {
  private readonly installs: Array<{
    commit?: PluginInstallRuntimeCommit;
    cleanups: PluginSourceCleanup[];
  }> = [];
  private targets: PluginInstallBatchTarget[] = [];
  private readonly retained = new Set<string>();
  private readonly sourceChecks = new Map<string, () => void>();
  private databasePath?: string;
  private phase: "collecting" | "prepared" | "applying" | "closed" = "collecting";

  constructor(
    private readonly options: Pick<OpenClawStateDatabaseOptions, "env" | "path" | "database">,
    private readonly reload: PluginInstallBatchReload,
  ) {}

  get hasCommitted(): boolean {
    return this.installs.some((entry) => entry.commit !== undefined);
  }

  close(): void {
    this.phase = "closed";
    for (const entry of this.installs.splice(0)) {
      entry.commit = undefined;
      entry.cleanups.length = 0;
    }
    this.targets = [];
    this.retained.clear();
    this.sourceChecks.clear();
  }

  private assertOpen() {
    if (this.phase === "closed") {
      throw new Error("Plugin installation batch is closed");
    }
  }

  private assertCollecting() {
    if (this.phase !== "collecting") {
      throw new Error("Plugin installation batch no longer accepts mutations");
    }
  }

  install(): PluginInstallRuntimeDeferral {
    this.assertCollecting();
    const entry: (typeof this.installs)[number] = { cleanups: [] };
    this.installs.push(entry);
    return {
      record: (commit, assertSourceCurrent) => {
        this.assertCollecting();
        if (entry.commit) {
          throw new Error("Plugin install already committed in this batch");
        }
        entry.commit = commit;
        if (assertSourceCurrent) {
          this.sourceChecks.set(commit.pluginId, assertSourceCurrent);
        } else {
          this.sourceChecks.delete(commit.pluginId);
        }
      },
      deferCleanup: (cleanup, sourcePath) => {
        this.assertCollecting();
        if (!entry.commit) {
          throw new Error("Cannot transfer cleanup before plugin installation commits");
        }
        const configPath = entry.commit.write.configWrite.path;
        const original = fs.lstatSync(sourcePath, { bigint: true, throwIfNoEntry: false });
        entry.cleanups.push(async (assertOwned, warn) => {
          const assertUnclaimed = () => {
            assertOwned();
            const current = fs.lstatSync(sourcePath, { bigint: true, throwIfNoEntry: false });
            // Cleanup can mutate or remove its own tree, but never adopt a replacement inode.
            if (
              current &&
              (!original || current.dev !== original.dev || current.ino !== original.ino)
            ) {
              throw new Error(`Retired plugin source changed before cleanup: ${sourcePath}`);
            }
            const index = indexFromRow(
              readPersistedInstalledPluginIndexRowSync({ filePath: this.databasePath })?.value_json,
            );
            if (!index) {
              throw new Error("Plugin index disappeared before source cleanup");
            }
            const config = readCurrentConfigForPolicyCheck({
              configPath,
              env: this.options.env ?? process.env,
            });
            if (
              createInstalledPluginOwnershipResolver(index, this.options.env).isSourceInUse(
                sourcePath,
                config.plugins?.load?.paths ?? [],
              )
            ) {
              throw new Error(`Retired plugin source acquired a current owner: ${sourcePath}`);
            }
            assertOwned();
          };
          assertUnclaimed();
          await cleanup(assertUnclaimed, warn);
        });
      },
    };
  }

  retain(pluginId: string): void {
    this.assertCollecting();
    this.retained.add(pluginId);
  }

  /** Called before the original batch lease exits, after its compensation has settled. */
  prepare(lease: PluginLifecycleLeaseContext): void {
    this.assertCollecting();
    lease.assertOwned();
    this.databasePath = lease.databasePath;
    if (!this.hasCommitted && this.retained.size === 0) {
      this.phase = "prepared";
      return;
    }
    const index = indexFromRow(
      readPersistedInstalledPluginIndexRowSync({ filePath: lease.databasePath })?.value_json,
    );
    const current = index?.installRecords ?? {};
    const targets = new Map<string, PluginInstallBatchTarget>();
    for (const pluginId of this.retained) {
      if (!current[pluginId]) {
        throw new Error(`Resumable plugin ${pluginId} is no longer installed`);
      }
      const source = inspectPluginGenerationSources(
        (index?.plugins ?? [])
          .filter(
            (entry) =>
              resolveInstalledPluginIndexInstallOwner(entry) === pluginId &&
              entry.enabled &&
              entry.origin !== "bundled",
          )
          .map((entry) => ({
            pluginId: entry.pluginId,
            rootDir: entry.rootDir,
            entryFile: entry.source === entry.manifestPath ? entry.source : undefined,
          })),
      );
      this.sourceChecks.set(pluginId, source.assertSourceCurrent);
      targets.set(pluginId, {
        pluginId,
        installHash: hashStableJson(current[pluginId]),
        sourceDigests: source.sourceDigests,
      });
    }
    const finalCommits = new Map<string, PluginInstallRuntimeCommit>();
    for (const { commit } of this.installs) {
      if (!commit) {
        continue;
      }
      finalCommits.set(commit.pluginId, commit);
    }
    for (const commit of finalCommits.values()) {
      const { pluginId, write } = commit;
      if (write.mutation.databasePath !== lease.databasePath) {
        throw new Error("Plugin batch commit belongs to a different state database");
      }
      const installed = indexFromRow(write.mutation.after.value_json)?.installRecords[pluginId];
      if (commit.operation === "uninstall") {
        if (installed || current[pluginId]) {
          throw new Error(`Plugin ${pluginId} compensation did not remove its installed record`);
        }
        targets.delete(pluginId);
        continue;
      }
      if (!installed) {
        throw new Error(`Plugin ${pluginId} is missing from its committed index receipt`);
      }
      const installHash = hashStableJson(installed);
      if (!current[pluginId] || hashStableJson(current[pluginId]) !== installHash) {
        throw new Error(`Plugin ${pluginId} changed during batch settlement`);
      }
      targets.set(pluginId, { pluginId, installHash, sourceDigests: commit.sourceDigests });
    }
    this.targets = [...targets.values()].toSorted((a, b) => a.pluginId.localeCompare(b.pluginId));
    this.phase = "prepared";
  }

  /** The caller must leave every batch lease before invoking the captured runtime client. */
  async finish(warn: (message: string) => void): Promise<PluginRuntimeApplication | undefined> {
    if (this.phase !== "prepared" || !this.databasePath || hasPluginLifecycleLease()) {
      throw new Error("Plugin batch was not prepared or its handoff already started");
    }
    this.phase = "applying";
    const targets = this.targets;
    let application: PluginRuntimeApplication | undefined;
    try {
      if (targets.length === 0) {
        return undefined;
      }
      application = await this.reload(targets);
      this.assertOpen();
      for (const warning of application.warnings ?? []) {
        warn(warning);
      }
      await withPluginLifecycleLease(this.options, async (lease) => {
        const assertCurrent = () => {
          this.assertOpen();
          lease.assertOwned();
          if (lease.databasePath !== this.databasePath) {
            throw new Error("Plugin cleanup belongs to a different state database");
          }
          const records =
            indexFromRow(
              readPersistedInstalledPluginIndexRowSync({ filePath: lease.databasePath })
                ?.value_json,
            )?.installRecords ?? {};
          for (const target of targets) {
            this.sourceChecks.get(target.pluginId)?.();
            if (
              !records[target.pluginId] ||
              hashStableJson(records[target.pluginId]) !== target.installHash
            ) {
              throw new Error(`Plugin ${target.pluginId} changed before committed source cleanup`);
            }
          }
        };
        for (const { commit, cleanups } of this.installs) {
          if (!commit || !targets.some((target) => target.pluginId === commit.pluginId)) {
            continue;
          }
          for (const cleanup of cleanups) {
            assertCurrent();
            await cleanup(assertCurrent, warn);
            assertCurrent();
          }
        }
      });
      return application;
    } catch (error) {
      throw new Error(
        `Plugin installations are saved: ${targets.map((target) => target.pluginId).join(", ")}. ` +
          (application
            ? `Gateway generation ${application.generation} was applied, but source cleanup failed. `
            : "Runtime activation was not confirmed. ") +
          `Fix the reported issue, then run openclaw plugins reload <plugin-id> for each affected plugin. ${formatErrorMessage(error)}`,
        { cause: error },
      );
    } finally {
      this.close();
    }
  }
}
