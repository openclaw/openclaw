import type { OpenClawConfig } from "../config/types.openclaw.js";
import { resolveDefaultPluginExtensionsDir } from "./install-paths.js";
import {
  attachPluginInstallOwnerMigrations,
  resolvePluginInstallTransaction,
  resolvePluginInstallTransactionRequest,
  settlePluginInstallTransactions,
  type PluginInstallTransaction,
} from "./install-transaction.js";
import { repairInstalledOpenClawHostLinks } from "./plugin-peer-link.js";
import type {
  PluginUpdateLogger,
  PluginUpdateOutcome,
  PluginUpdateSummary,
} from "./update-source.js";

export function createPluginUpdateTransactionState(params: object) {
  return {
    transactions: [] as PluginInstallTransaction[],
    installOwnerMigrations: {} as Record<string, string>,
    transactionSink: resolvePluginInstallTransactionRequest(params)?.transactionSink,
  };
}

export function recordPluginUpdateTransaction(
  state: ReturnType<typeof createPluginUpdateTransactionState>,
  result: object,
  pluginId: string,
  resolvedPluginId: string,
): void {
  const transaction = resolvePluginInstallTransaction(result);
  if (transaction) {
    state.transactions.push(transaction);
    state.transactionSink?.push(transaction);
  }
  if (resolvedPluginId !== pluginId) {
    state.installOwnerMigrations[pluginId] = resolvedPluginId;
  }
}

export async function finalizePluginUpdateSummary(params: {
  config: OpenClawConfig;
  changed: boolean;
  outcomes: PluginUpdateOutcome[];
  ranNpmInstaller: boolean;
  logger: PluginUpdateLogger;
  transactionState: ReturnType<typeof createPluginUpdateTransactionState>;
  prepareEffect?: () => void | Promise<void>;
  beforePersistentApply?: () => void;
  beforePersistentEffect?: () => void | Promise<void>;
}): Promise<PluginUpdateSummary> {
  let changed = params.changed;
  if (params.ranNpmInstaller) {
    try {
      const repaired = await repairInstalledOpenClawHostLinks({
        managedNpmRoots: [],
        installRecords: params.config.plugins?.installs ?? {},
        extensionsDir: resolveDefaultPluginExtensionsDir(),
        logger: params.logger,
        beforePersistentApply: params.beforePersistentApply,
        beforePersistentEffect: params.beforePersistentEffect,
        onPackageReadError: (error, packageDir) => {
          params.logger.warn?.(
            `Could not repair openclaw peer link at ${packageDir}: ${String(error)}`,
          );
        },
      });
      changed = repaired.registeredRepaired > 0 || changed;
    } catch (error) {
      await settlePluginInstallTransactions(
        params.transactionState.transactions,
        "rollback",
        { error },
        params.prepareEffect,
      );
      throw error;
    }
  }
  const summary = { config: params.config, changed, outcomes: params.outcomes };
  return Object.keys(params.transactionState.installOwnerMigrations).length > 0
    ? attachPluginInstallOwnerMigrations(summary, params.transactionState.installOwnerMigrations)
    : summary;
}
