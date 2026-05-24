import {
  readConfigFileSnapshot,
  transformConfigFileWithRetry,
  validateConfigObjectWithPlugins,
} from "./config.js";
import {
  applyExperimentalConfigFlagValue,
  applyExperimentalConfigSelection,
  readExperimentalConfigFlagStates,
  resolveExperimentalConfigFlag,
  type ExperimentalConfigFlagDelta,
  type ExperimentalConfigFlagState,
} from "./experimental-flags.js";
import type { ConfigWriteAfterWrite } from "./runtime-snapshot.js";

export type ExperimentalConfigFlagWriteResult = {
  path: string;
  value: boolean;
  changed: boolean;
};

export type ExperimentalConfigSelectionWriteResult = {
  changed: boolean;
  deltas: ExperimentalConfigFlagDelta[];
};

class ExperimentalConfigNoopMutation extends Error {}

function assertEditableConfigSnapshot(
  snapshot: Awaited<ReturnType<typeof readConfigFileSnapshot>>,
): asserts snapshot is Awaited<ReturnType<typeof readConfigFileSnapshot>> & {
  parsed: Record<string, unknown>;
} {
  if (!snapshot.valid || !snapshot.parsed || typeof snapshot.parsed !== "object") {
    throw new Error("config file is invalid; fix it before using /experimental");
  }
  if (Array.isArray(snapshot.parsed)) {
    throw new Error("config file must be an object before using /experimental");
  }
}

export async function readExperimentalConfigFlagStatesFromFile(): Promise<
  ExperimentalConfigFlagState[]
> {
  const snapshot = await readConfigFileSnapshot();
  assertEditableConfigSnapshot(snapshot);
  return readExperimentalConfigFlagStates(snapshot.runtimeConfig ?? snapshot.resolved);
}

export async function writeExperimentalConfigFlagToFile(params: {
  path: string;
  value: boolean;
  afterWrite?: ConfigWriteAfterWrite;
}): Promise<ExperimentalConfigFlagWriteResult> {
  const flag = resolveExperimentalConfigFlag(params.path);
  if (!flag) {
    throw new Error(`unknown experimental flag: ${params.path}`);
  }
  try {
    const committed = await transformConfigFileWithRetry<ExperimentalConfigFlagWriteResult>({
      base: "source",
      ...(params.afterWrite ? { afterWrite: params.afterWrite } : {}),
      transform: (currentConfig) => {
        const { nextConfig, delta } = applyExperimentalConfigFlagValue(
          structuredClone(currentConfig) as Record<string, unknown>,
          {
            path: flag.path,
            value: params.value,
          },
        );
        if (!delta) {
          throw new ExperimentalConfigNoopMutation();
        }
        const validated = validateConfigObjectWithPlugins(nextConfig);
        if (!validated.ok) {
          const issue = validated.issues[0];
          throw new Error(
            `config invalid after experimental update (${issue.path}: ${issue.message})`,
          );
        }
        return {
          nextConfig: validated.config,
          result: { path: flag.path, value: params.value, changed: true },
        };
      },
    });
    return committed.result ?? { path: flag.path, value: params.value, changed: true };
  } catch (err) {
    if (err instanceof ExperimentalConfigNoopMutation) {
      return { path: flag.path, value: params.value, changed: false };
    }
    throw err;
  }
}

export async function writeExperimentalConfigSelectionToFile(params: {
  selectedPaths: ReadonlySet<string>;
  afterWrite?: ConfigWriteAfterWrite;
}): Promise<ExperimentalConfigSelectionWriteResult> {
  try {
    const committed = await transformConfigFileWithRetry<ExperimentalConfigSelectionWriteResult>({
      base: "source",
      ...(params.afterWrite ? { afterWrite: params.afterWrite } : {}),
      transform: (currentConfig) => {
        const { nextConfig, deltas } = applyExperimentalConfigSelection(
          structuredClone(currentConfig) as Record<string, unknown>,
          params.selectedPaths,
        );
        if (deltas.length === 0) {
          throw new ExperimentalConfigNoopMutation();
        }
        const validated = validateConfigObjectWithPlugins(nextConfig);
        if (!validated.ok) {
          const issue = validated.issues[0];
          throw new Error(
            `config invalid after experimental update (${issue.path}: ${issue.message})`,
          );
        }
        return {
          nextConfig: validated.config,
          result: { changed: true, deltas },
        };
      },
    });
    return committed.result ?? { changed: true, deltas: [] };
  } catch (err) {
    if (err instanceof ExperimentalConfigNoopMutation) {
      return { changed: false, deltas: [] };
    }
    throw err;
  }
}
