import { isDeepStrictEqual } from "node:util";
import type { DeferredPluginMigration } from "../infra/deferred-plugin-migrations.js";
import { initializeNativeSessionCatalogPreferences } from "../plugins/native-session-catalog-config.js";
import { collectChangedPaths } from "./config-change-paths.js";
import { cloneEnvWithPlatformSemantics, createConfigRuntimeEnvBase } from "./config-env-vars.js";
import {
  applyUnsetPathsForWrite,
  resolveManagedUnsetPathsForWrite,
} from "./config-path-mutation.js";
import { preserveDeferredPluginMigrationConfig } from "./deferred-plugin-migration-config.js";
import { resolveKeyedAgentEntryIncludePreservation } from "./include-write-boundary.js";
import type { ConfigIoContext } from "./io.context.js";
import { projectWebhookMigrationIncludeWrite, stampConfigWriteMetadata } from "./io.meta.js";
import {
  containsConfigIncludeDirective,
  hashConfigRaw,
  hashConfigRevision,
  hasConfigMeta,
  resolveConfigForRead,
  resolveGatewayMode,
  restoreAuthoredTildePathsForWrite,
} from "./io.read-helpers.js";
import type { ConfigWriteInputBasis, ConfigWriteOptions } from "./io.types.js";
import { createConfigValidationFailedError } from "./io.write-errors.js";
import { injectExplicitlySetPaths, resolvePersistCandidateForWrite } from "./io.write-prepare.js";
import {
  resolveConfigSizeBaselineBytes,
  resolveConfigWriteSuspiciousReasons,
} from "./io.write-safety.js";
import type { prepareConfigWriteTopology } from "./io.write-topology.js";
import { applyMergePatch, createMergePatch } from "./merge-patch.js";
import { setConfigResolutionFacts } from "./resolution-facts.js";
import type { ConfigFileSnapshot, OpenClawConfig } from "./types.js";
import { validateConfigObjectRawWithPlugins } from "./validation.js";
import { rejectConfigNonFiniteNumbers } from "./value-tree.js";

// Preview and publication must assess the same authored, stamped bytes. Runtime
// activation, audit records, rejection artifacts, and file writes stay with the writer.
export function prepareConfigWritePayload(
  context: ConfigIoContext,
  snapshot: ConfigFileSnapshot,
  topology: Awaited<ReturnType<typeof prepareConfigWriteTopology>>,
  options: ConfigWriteOptions,
  deferredPluginMigrations: readonly DeferredPluginMigration[],
) {
  const { deps } = context;
  const {
    authoredConfig,
    authoredSourceConfig,
    authoredRuntimeConfig,
    explicitSetPaths,
    explicitSetValueSource,
    persistCanonicalAgentRoster,
    preserveLegacyAgentRoster,
  } = topology;
  const unsetPaths = resolveManagedUnsetPathsForWrite(options.unsetPaths);
  const inputBasis: ConfigWriteInputBasis = {
    kind: options.inputBase ?? "runtime",
    config: options.inputBase === "source" ? authoredSourceConfig : authoredRuntimeConfig,
  };
  let persistCandidate: unknown = authoredConfig;
  const changedPaths = new Set<string>();
  collectChangedPaths(inputBasis.config, authoredConfig, "", changedPaths);
  for (const changedPath of [...explicitSetPaths, ...(options.unsetPaths ?? [])]) {
    const normalizedPath = changedPath.filter((segment) => segment.length > 0).join(".");
    if (normalizedPath) {
      changedPaths.add(normalizedPath);
    }
  }
  const hasAuthoredIncludes = containsConfigIncludeDirective(snapshot.parsed);
  // Doctor repairs need the same authored projection so roster moves preserve nested includes.
  // Missing snapshots also use this owner; exact bootstrap rosters carry explicitSetPaths.
  if (snapshot.valid || (snapshot.exists && hasAuthoredIncludes)) {
    const webhookMigration = hasAuthoredIncludes
      ? projectWebhookMigrationIncludeWrite(authoredSourceConfig, authoredConfig)
      : undefined;
    const keyedAgentEntryIncludes = resolveKeyedAgentEntryIncludePreservation({
      configPath: snapshot.path,
      provenance: snapshot.includeProvenance,
    });
    persistCandidate = resolvePersistCandidateForWrite({
      inputBasis,
      runtimeConfig: authoredRuntimeConfig,
      sourceConfig: authoredSourceConfig,
      sourceConfigValid: snapshot.valid,
      sourceConfigBeforeMigrations: snapshot.sourceConfigBeforeMigrations,
      nextConfig: webhookMigration?.config ?? authoredConfig,
      rootAuthoredConfig: snapshot.parsed,
      agentRosterIncludeOwned: snapshot.agentRosterIncludeOwned,
      keyedAgentEntryIncludePaths: keyedAgentEntryIncludes?.includePaths,
      unsetPaths,
      explicitSetPaths: explicitSetPaths.filter(
        (field) => !webhookMigration?.paths.some((pin) => isDeepStrictEqual(pin, field)),
      ),
      explicitSetValueSource,
      persistCanonicalAgentRoster,
      allowedAgentRosterRemovals: options.allowedAgentRosterRemovals,
      allowIncludeAncestorExplicitSetPaths: options.allowIncludeAncestorExplicitSetPaths,
      preserveLegacyAgentRoster,
    });
    if (webhookMigration) {
      persistCandidate = injectExplicitlySetPaths({
        valueSource: authoredConfig,
        persistedCandidate: persistCandidate,
        runtimeConfig: authoredRuntimeConfig,
        sourceConfig: authoredSourceConfig,
        rootAuthoredConfig: snapshot.parsed,
        explicitSetPaths: webhookMigration.paths,
        allowIncludeAncestorExplicitSetPaths: true,
      });
    }
  }
  const validationEnvBase = createConfigRuntimeEnvBase(
    snapshot.sourceConfigBeforeMigrations ?? snapshot.sourceConfig,
    deps.env,
  );
  const resolveValidationCandidate = (candidate: unknown) => {
    // Validate removals now; apply them once to the final authored output after materialization.
    const config = applyUnsetPathsForWrite(candidate, unsetPaths);
    if (containsConfigIncludeDirective(config)) {
      return context.resolveRuntimePreflightSourceConfig(
        config,
        undefined,
        undefined,
        validationEnvBase,
      );
    }
    // Plain writes resolve references without running the preflight's compatibility migrations.
    const resolution = resolveConfigForRead(
      config,
      cloneEnvWithPlatformSemantics(validationEnvBase),
      deps.lowerPrecedenceEnv,
    );
    setConfigResolutionFacts(resolution.resolvedConfigRaw, resolution.resolutionFacts);
    return resolution.resolvedConfigRaw;
  };
  const validationCandidate = resolveValidationCandidate(persistCandidate);
  const validateCandidate = (candidate: unknown) => {
    const result = validateConfigObjectRawWithPlugins(candidate, {
      ...context.pathResolution,
      pluginValidation: options.skipPluginValidation ? "skip" : "full",
      semanticValidation: "strict",
      preservedLegacyRootKeys: options.preservedLegacyRootKeys,
      deferredPluginMigrations,
    });
    if (!result.ok) {
      throw createConfigValidationFailedError(result.issues);
    }
    return result;
  };
  // Validate authored structure before stamping can replace malformed parents.
  validateCandidate(validationCandidate);
  // SAFETY: the original resolved input was just validated; retain raw values, not parser defaults.
  const validatedCandidate = validationCandidate as OpenClawConfig;
  const previousSource =
    snapshot.authoredConfig ?? snapshot.sourceConfigBeforeMigrations ?? snapshot.sourceConfig;
  const materialized = stampConfigWriteMetadata(
    snapshot.exists
      ? validatedCandidate
      : initializeNativeSessionCatalogPreferences(validatedCandidate),
    options.lastTouchedVersionOverride,
    snapshot.exists ? previousSource : null,
  );
  // Resolve policy from included facts, but persist only its delta beside authored directives.
  persistCandidate = applyMergePatch(
    persistCandidate,
    createMergePatch(validationCandidate, materialized),
  );
  const validated = validateCandidate(resolveValidationCandidate(persistCandidate));
  const tildeRestoredOutputConfig = restoreAuthoredTildePathsForWrite(
    persistCandidate,
    snapshot.parsed,
    undefined,
    deps.homedir(),
  ) as OpenClawConfig; // SAFETY: validation established the root shape; tilde restoration only changes path strings.
  const stampedOutputConfig = stampConfigWriteMetadata(
    preserveDeferredPluginMigrationConfig({
      sourceConfig: snapshot.parsed,
      nextConfig: applyUnsetPathsForWrite(tildeRestoredOutputConfig, unsetPaths),
      pending: deferredPluginMigrations,
      writeOptions: { unsetPaths: options.unsetPaths },
    }),
    options.lastTouchedVersionOverride,
  );
  rejectConfigNonFiniteNumbers(stampedOutputConfig);
  const json = JSON.stringify(stampedOutputConfig, null, 2).trimEnd().concat("\n");
  const nextHash = hashConfigRaw(json);
  const previousHash = hashConfigRaw(snapshot.raw);
  const changedPathCount = changedPaths.size;
  const previousBytes =
    typeof snapshot.raw === "string" ? Buffer.byteLength(snapshot.raw, "utf-8") : null;
  const sizeBaselineBytes = resolveConfigSizeBaselineBytes({
    raw: snapshot.raw,
    json5: deps.json5,
    lastTouchedVersionOverride: options.lastTouchedVersionOverride,
  });
  const nextBytes = Buffer.byteLength(json, "utf-8");
  const hasMetaBefore = hasConfigMeta(snapshot.parsed);
  const gatewayModeBefore = resolveGatewayMode(snapshot.resolved);
  const includeFileHashes: Record<string, string> = {};
  const includeFileTargets: Record<string, string> = {};
  const sourceConfigForPreflight = context.resolveRuntimePreflightSourceConfig(
    stampedOutputConfig,
    includeFileHashes,
    includeFileTargets,
    validationEnvBase,
  );
  const committedRevision = hashConfigRevision(json, includeFileHashes, includeFileTargets);
  // Compare resolved modes: an unchanged authored $include has no local mode literal.
  const gatewayModeAfter = resolveGatewayMode(sourceConfigForPreflight);
  const suspiciousReasons = resolveConfigWriteSuspiciousReasons({
    existsBefore: snapshot.exists,
    unreadableBefore: snapshot.readError != null,
    sizeBaselineBytes,
    nextBytes,
    hasMetaBefore,
    gatewayModeBefore,
    gatewayModeAfter,
  });

  return {
    json,
    stampedOutputConfig,
    validated,
    changedPaths,
    changedPathCount,
    nextHash,
    previousHash,
    previousBytes,
    nextBytes,
    hasMetaBefore,
    gatewayModeBefore,
    gatewayModeAfter,
    includeFileHashes,
    includeFileTargets,
    sourceConfigForPreflight,
    committedRevision,
    suspiciousReasons,
  };
}
