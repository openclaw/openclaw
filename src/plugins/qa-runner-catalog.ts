import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { listBundledPluginMetadata } from "./bundled-plugin-metadata.js";

export type QaRunnerCatalogEntry = {
  pluginId: string;
  commandName: string;
  description?: string;
  npmSpec: string;
};

const QA_RUNNER_CATALOG_JSON_PATH = fileURLToPath(
  new URL("../../scripts/lib/qa-runner-catalog.json", import.meta.url),
);

export function listBundledQaRunnerCatalog(): readonly QaRunnerCatalogEntry[] {
  if (!fs.existsSync(QA_RUNNER_CATALOG_JSON_PATH)) {
    return [];
  }
  return JSON.parse(fs.readFileSync(QA_RUNNER_CATALOG_JSON_PATH, "utf8")) as QaRunnerCatalogEntry[];
}

export function collectBundledQaRunnerCatalog(params?: {
  rootDir?: string;
}): readonly QaRunnerCatalogEntry[] {
  const catalog: QaRunnerCatalogEntry[] = [];
  const seenCommandNames = new Map<string, string>();

  for (const entry of listBundledPluginMetadata({
    rootDir: params?.rootDir,
    includeChannelConfigs: false,
  })) {
    const qaRunners = entry.manifest.qaRunners ?? [];
    const npmSpec = entry.packageManifest?.install?.npmSpec?.trim() || entry.packageName?.trim();
    if (!npmSpec) {
      continue;
    }
    for (const runner of qaRunners) {
      const previousOwner = seenCommandNames.get(runner.commandName);
      if (previousOwner) {
        throw new Error(
          `QA runner command "${runner.commandName}" declared by both "${previousOwner}" and "${entry.manifest.id}"`,
        );
      }
      seenCommandNames.set(runner.commandName, entry.manifest.id);
      catalog.push({
        pluginId: entry.manifest.id,
        commandName: runner.commandName,
        ...(runner.description ? { description: runner.description } : {}),
        npmSpec,
      });
    }
  }

  return catalog.toSorted((left, right) => left.commandName.localeCompare(right.commandName));
}

export async function writeBundledQaRunnerCatalog(params: {
  repoRoot: string;
  check: boolean;
}): Promise<{ changed: boolean; jsonPath: string }> {
  const jsonPath = path.join(params.repoRoot, "scripts", "lib", "qa-runner-catalog.json");
  const expectedJson = `${JSON.stringify(collectBundledQaRunnerCatalog({ rootDir: params.repoRoot }), null, 2)}\n`;
  const currentJson = fs.existsSync(jsonPath) ? fs.readFileSync(jsonPath, "utf8") : "";
  const changed = currentJson !== expectedJson;

  if (!params.check && changed) {
    fs.mkdirSync(path.dirname(jsonPath), { recursive: true });
    fs.writeFileSync(jsonPath, expectedJson, "utf8");
  }

  return { changed, jsonPath };
}
