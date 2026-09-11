/** Doctor owns provider binding persistence and completion; planning is shared with startup. */
import { isDeepStrictEqual } from "node:util";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { captureAuthProfileOwnerScope } from "../../../agents/auth-profiles/path-resolve.js";
import { withAuthProfilePublicationLock } from "../../../agents/auth-profiles/publication.js";
import type { ConfigWriteOptions } from "../../../config/io.types.js";
import { isConfigIncludeOwnershipError } from "../../../config/io.write-errors.js";
import { GuardedConfigIncludeWriteError } from "../../../config/mutation-conflict.js";
import {
  prepareProviderUseBindingMigration,
  PROVIDER_USE_BINDING_MIGRATION,
  PROVIDER_USE_BINDING_SELECTION_VERSION,
  type ProviderUseBindingMigrationBindings,
} from "../../../config/provider-use-binding-plan.js";
import type { OpenClawConfig } from "../../../config/types.openclaw.js";
import {
  readLegacyMigrationReceiptFromDatabase,
  recordLegacyMigrationReceipt,
  resolveLegacyMigrationSourceKey,
} from "../../../infra/state-migrations.receipts.js";
import { runOpenClawStateWriteTransaction } from "../../../state/openclaw-state-db.js";

/** Carry only approved migration work into Doctor's delayed config writer. */
export function resolveProviderUseBindingWriteMetadata(
  migration: Awaited<ReturnType<typeof prepareProviderUseBindingMigration>>,
  options: {
    shouldWriteConfig: boolean;
    shouldRepair: boolean;
    blocksWrite?: boolean;
    explicitSetPaths?: readonly (readonly string[])[];
  },
) {
  // Startup may already project these values. Doctor must persist the selected entries
  // even when they are identical to the runtime snapshot, including an empty declaration.
  const explicitSetPaths = [
    ...(options.explicitSetPaths ?? []),
    ...Object.keys(migration.bindings ?? {}).map((provider) => ["models", "providers", provider]),
  ];
  return {
    ...(options.shouldWriteConfig && explicitSetPaths.length > 0 ? { explicitSetPaths } : {}),
    ...(options.shouldWriteConfig && migration.bindings
      ? { providerUseBindings: migration.bindings }
      : {}),
    ...(options.shouldWriteConfig && migration.unsetPaths
      ? { unsetPaths: migration.unsetPaths }
      : {}),
    ...(migration.pending &&
    options.blocksWrite !== true &&
    (options.shouldWriteConfig || (options.shouldRepair && migration.changes.length === 0))
      ? { providerUseBindingMigrationPending: true }
      : {}),
  };
}

/** Recheck proposed bindings after interactive or asynchronous repairs, before persistence. */
export function revalidateProviderUseBindingMigration(params: {
  config: OpenClawConfig;
  sourceConfig?: OpenClawConfig;
  configPath: string;
  env: NodeJS.ProcessEnv;
  bindings: Readonly<ProviderUseBindingMigrationBindings>;
}) {
  const config = structuredClone(params.config);
  for (const [provider, binding] of Object.entries(params.bindings)) {
    const persisted = params.sourceConfig?.models?.providers?.[provider];
    if (
      persisted &&
      config.models?.providers &&
      isDeepStrictEqual(config.models.providers[provider]?.apiKey, binding.apiKey)
    ) {
      config.models.providers[provider] = structuredClone(persisted);
    }
  }
  const analysis = structuredClone(config);
  const proposed = Object.entries(params.bindings).filter(
    ([provider, binding]) =>
      !params.sourceConfig?.models?.providers?.[provider] &&
      Object.hasOwn(config.models?.providers ?? {}, provider) &&
      isDeepStrictEqual(config.models?.providers?.[provider]?.apiKey, binding.apiKey),
  );
  for (const [provider] of proposed) {
    delete analysis.models?.providers?.[provider];
  }
  const checked = prepareProviderUseBindingMigration({ ...params, config: analysis });
  const bindings: ProviderUseBindingMigrationBindings = {};
  for (const [provider, binding] of proposed) {
    if (isDeepStrictEqual(checked.bindings?.[provider], binding)) {
      bindings[provider] = binding;
      continue;
    }
    removeGeneratedProviderCredential(config, provider, params.sourceConfig);
  }
  const deferred = Object.keys(checked.bindings ?? {}).filter(
    (provider) => !Object.hasOwn(bindings, provider),
  );
  return {
    config,
    bindings,
    pending:
      checked.pending && Object.keys(bindings).length === proposed.length && deferred.length === 0,
    warnings: [
      ...(checked.warnings ?? []),
      ...(deferred.length
        ? [
            `Selected providers ${deferred.join(", ")} still need binding; rerun "openclaw doctor --fix".`,
          ]
        : []),
    ],
    changes: Object.entries(bindings).map(([provider, binding]) =>
      binding.apiKey
        ? `Bound selected provider ${provider} to ${binding.apiKey.id} with an env SecretRef.`
        : `Declared selected provider ${provider} for its configured credential chain.`,
    ),
  };
}

function removeGeneratedProviderCredential(
  config: OpenClawConfig,
  provider: string,
  sourceConfig?: OpenClawConfig,
): void {
  const entry = config.models?.providers?.[provider];
  if (entry) {
    delete entry.apiKey;
    const authoredFields = Object.entries(entry).filter(
      ([key, value]) =>
        !(key === "baseUrl" && value === "") &&
        !(key === "models" && Array.isArray(value) && value.length === 0),
    );
    if (authoredFields.length === 0) {
      delete config.models?.providers?.[provider];
    }
  }
  if (
    config.models?.providers &&
    Object.keys(config.models.providers).length === 0 &&
    !sourceConfig?.models?.providers
  ) {
    delete config.models.providers;
    if (Object.keys(config.models).length === 0 && !sourceConfig?.models) {
      delete config.models;
    }
  }
}

type CheckedProviderBindings = ReturnType<typeof revalidateProviderUseBindingMigration>;
class ProviderUseBindingPublicationChanged extends Error {
  constructor(readonly checked: CheckedProviderBindings) {
    super("Provider credentials changed before binding publication.");
  }
}

/** Account writes and the config rename share one synchronous publication fence. */
export async function writeProviderUseBindingMigration(
  params: Parameters<typeof revalidateProviderUseBindingMigration>[0],
  write: (
    checked: CheckedProviderBindings,
    withCommit?: ConfigWriteOptions["withCommit"],
  ) => Promise<void>,
): Promise<CheckedProviderBindings> {
  const owner = captureAuthProfileOwnerScope(params.env);
  const scopedParams = () => ({
    ...params,
    env: {
      ...params.env,
      OPENCLAW_STATE_DIR: owner.stateDir,
      OPENCLAW_AGENT_DIR: owner.sharedMainDir,
    },
  });
  let checked = revalidateProviderUseBindingMigration(scopedParams());
  try {
    await write(
      checked,
      Object.keys(checked.bindings).length === 0
        ? undefined
        : (publish) => {
            let entered = false;
            try {
              const currentParams = scopedParams();
              withAuthProfilePublicationLock(currentParams.env, () => {
                entered = true;
                const current = revalidateProviderUseBindingMigration({
                  ...currentParams,
                  config: checked.config,
                  bindings: checked.bindings,
                });
                if (
                  !isDeepStrictEqual(current.config, checked.config) ||
                  !isDeepStrictEqual(current.bindings, checked.bindings) ||
                  (checked.pending && !current.pending)
                ) {
                  throw new ProviderUseBindingPublicationChanged(current);
                }
                publish();
              });
            } catch (error) {
              if (entered) {
                throw error;
              }
              // An unavailable external lock cannot certify a migration or prevent startup.
              throw new ProviderUseBindingPublicationChanged(checked);
            }
          },
    );
  } catch (error) {
    if (error instanceof ProviderUseBindingPublicationChanged) {
      checked = error.checked;
    } else if (
      error instanceof GuardedConfigIncludeWriteError ||
      isConfigIncludeOwnershipError(error)
    ) {
      const selections = Object.entries(checked.bindings)
        .map(([provider, binding]) => `${provider} (${binding.apiKey?.id ?? "credential chain"})`)
        .join(", ");
      const includePaths =
        error instanceof GuardedConfigIncludeWriteError
          ? error.includePath
          : (error.includeTargets?.join(", ") ?? error.ownedConfigPath);
      checked.warnings.push(
        `Provider bindings ${selections} were not written to included config ${includePaths}. Bind them explicitly in that file.`,
      );
    } else {
      throw error;
    }
    // Publish independent repairs, but do not retry newly stale credential authority.
    for (const provider of Object.keys(checked.bindings)) {
      removeGeneratedProviderCredential(checked.config, provider, params.sourceConfig);
    }
    checked.bindings = {};
    checked.pending = false;
    checked.changes = [];
    checked.warnings.push(
      'Could not verify stored accounts before saving provider bindings; shared-key bindings were deferred. Rerun "openclaw doctor --fix".',
    );
    await write(checked);
  }
  return checked;
}

/** A successful Doctor write closes the upgrade window, including an empty selection. */
export function completeProviderUseBindingMigration(
  configPath: string,
  env: NodeJS.ProcessEnv,
): string[] {
  const sourceKey = resolveLegacyMigrationSourceKey(PROVIDER_USE_BINDING_MIGRATION, configPath);
  try {
    runOpenClawStateWriteTransaction(
      ({ db }) => {
        const completed = readLegacyMigrationReceiptFromDatabase(db, sourceKey);
        if (completed) {
          let report: unknown;
          try {
            report = JSON.parse(completed.reportJson);
          } catch {
            report = undefined;
          }
          if (
            isRecord(report) &&
            typeof report.selectionVersion === "number" &&
            report.selectionVersion >= PROVIDER_USE_BINDING_SELECTION_VERSION
          ) {
            return;
          }
        }
        recordLegacyMigrationReceipt(db, {
          sourceKey,
          migrationKind: PROVIDER_USE_BINDING_MIGRATION,
          sourcePath: configPath,
          targetTable: "migration_sources",
          sourceSha256: null,
          sourceSizeBytes: null,
          sourceRecordCount: null,
          runId: sourceKey,
          now: Date.now(),
          reportJson: JSON.stringify({
            completed: true,
            target: "models.providers",
            selectionVersion: PROVIDER_USE_BINDING_SELECTION_VERSION,
          }),
          upsert: completed !== null,
        });
      },
      { env },
    );
    return [];
  } catch {
    return ['Could not record the shared-key provider upgrade; rerun "openclaw doctor --fix".'];
  }
}
