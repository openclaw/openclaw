import { readAgentRosterProperty } from "../agents/agent-scope-config.js";
import { createConfigRuntimeEnvBase } from "./config-env-vars.js";
import { resolveWriteEnvSnapshotForPath, restoreEnvVarRefsFromResolved } from "./env-preserve.js";
import { resolveConfigEnvVars } from "./env-substitution.js";
import { coerceConfig, resolveConfigForRead } from "./io.read-helpers.js";
import type { ConfigWriteInputBasis, ConfigWriteOptions } from "./io.types.js";
import { setConfigResolutionFacts } from "./resolution-facts.js";
import type { ConfigFileSnapshot, OpenClawConfig } from "./types.js";

export type ConfigWriteSourceProjectionParams = {
  inputBasis?: ConfigWriteInputBasis;
  runtimeConfig: unknown;
  sourceConfig: unknown;
  nextConfig: unknown;
  unsetPaths?: readonly string[][];
  explicitSetPaths?: readonly (readonly string[])[];
  explicitSetValueSource?: unknown;
};

/** Keep reference identity for persistence separate from values used by physical owners. */
export function prepareProjectedConfigWriteValues(
  params: {
    snapshot: ConfigFileSnapshot;
    nextConfig: OpenClawConfig;
    env: NodeJS.ProcessEnv;
    writeOptions?: Pick<ConfigWriteOptions, "expectedConfigPath" | "envSnapshotForRestore">;
    lowerPrecedenceEnv?: Readonly<Record<string, string>>;
    explicitSetPaths?: readonly (readonly string[])[];
    explicitSetValueSource?: OpenClawConfig;
  },
  projectAuthoredAgentRosterForWrite: (params: {
    rootAuthoredConfig: unknown;
    sourceConfigBeforeMigrations?: unknown;
  }) => unknown,
) {
  const { snapshot } = params;
  const source = snapshot.sourceConfigBeforeMigrations ?? snapshot.sourceConfig;
  const authored = snapshot.authoredConfig ?? snapshot.parsed;
  const inputEnv = resolveWriteEnvSnapshotForPath({
    actualConfigPath: snapshot.path,
    expectedConfigPath: params.writeOptions?.expectedConfigPath,
    envSnapshotForRestore: params.writeOptions?.envSnapshotForRestore,
  });
  // Incoming values belong to the acquisition read. The locked snapshot still
  // owns the baseline and current-env resolution used by physical owners.
  const inputSource = inputEnv
    ? resolveConfigEnvVars(authored, inputEnv, { onMissing: () => {} })
    : source;
  const restore = (
    config: OpenClawConfig,
    explicitSetPaths?: readonly (readonly string[])[],
    comparisonSource: unknown = source,
  ) => {
    const canonicalRoster = readAgentRosterProperty(config)?.kind === "entries";
    const project = (value: unknown) =>
      canonicalRoster
        ? projectAuthoredAgentRosterForWrite({
            rootAuthoredConfig: value,
            sourceConfigBeforeMigrations: comparisonSource,
          })
        : value;
    return coerceConfig(
      restoreEnvVarRefsFromResolved(
        config,
        project(authored),
        project(comparisonSource),
        explicitSetPaths,
      ),
    );
  };
  const authoredConfig = restore(params.nextConfig, params.explicitSetPaths, inputSource);
  const resolution = resolveConfigForRead(
    authoredConfig,
    createConfigRuntimeEnvBase(source, params.env),
    params.lowerPrecedenceEnv,
  );
  const resolvedConfig = coerceConfig(resolution.resolvedConfigRaw);
  setConfigResolutionFacts(resolvedConfig, resolution.resolutionFacts);
  return {
    authoredConfig,
    resolutionEnv: resolution.envSnapshotForRestore,
    explicitSetValueSource: params.explicitSetValueSource
      ? restore(params.explicitSetValueSource, params.explicitSetPaths, inputSource)
      : authoredConfig,
    resolvedConfig,
    authoredSourceConfig: restore(snapshot.sourceConfig),
    authoredRuntimeConfig: restore(snapshot.runtimeConfig),
  };
}
