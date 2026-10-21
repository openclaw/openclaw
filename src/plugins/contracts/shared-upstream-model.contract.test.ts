import fs from "node:fs";
import path from "node:path";
import { asOptionalRecord as readRecord } from "@openclaw/normalization-core/record-coerce";
import { describe, expect, it } from "vitest";
import { listGitTrackedFiles } from "../../test-utils/repo-files.js";

const repoRoot = path.resolve(import.meta.dirname, "../../..");
const CODE_MODE_TIER_LITERAL = /codeMode:\s*"(?:preferred|capable)"/;
// Minimax resolves cost per provider surface, so its rows cannot live in one
// manifest catalog and remain invisible to the manifest scan below.
const UNCONVERTED_SOURCE_CATALOG_PLUGINS = ["minimax"];

type CatalogEntry = {
  ref: string;
  groupKey: string;
  upstreamModel?: string;
  codeMode?: string;
};

function listBundledPluginFiles(): string[] {
  const files = listGitTrackedFiles({ repoRoot, pathspecs: "extensions" });
  if (!files) {
    throw new Error("unable to list bundled plugin files from git");
  }
  return files;
}

function readBundledManifests(): Array<Record<string, unknown>> {
  return listBundledPluginFiles()
    .filter((file) => /^extensions\/[^/]+\/openclaw\.plugin\.json$/.test(file))
    .map(
      (file) =>
        JSON.parse(fs.readFileSync(path.join(repoRoot, file), "utf8")) as Record<string, unknown>,
    );
}

// Group aggregator aliases with first-party rows, ignoring namespace and case.
function normalizeSharedModelId(modelId: string): string {
  return modelId.slice(modelId.indexOf("/") + 1).toLowerCase();
}

function collectCatalogEntries(): CatalogEntry[] {
  const entries: CatalogEntry[] = [];
  for (const manifest of readBundledManifests()) {
    const providers = readRecord(readRecord(manifest.modelCatalog)?.providers) ?? {};
    // CLI backends run their own harness, so catalog code-mode tiers never reach them.
    const cliBackends = new Set(
      Array.isArray(manifest.cliBackends) ? (manifest.cliBackends as string[]) : [],
    );
    for (const [providerId, provider] of Object.entries(providers)) {
      if (cliBackends.has(providerId)) {
        continue;
      }
      const models = readRecord(provider)?.models;
      if (!Array.isArray(models)) {
        continue;
      }
      for (const rawModel of models) {
        const model = readRecord(rawModel);
        const id = typeof model?.id === "string" ? model.id : undefined;
        if (!id) {
          continue;
        }
        const upstreamModel =
          typeof model?.upstreamModel === "string" ? model.upstreamModel : undefined;
        const codeMode = readRecord(model?.compat)?.codeMode;
        entries.push({
          ref: `${providerId}/${id}`,
          groupKey: normalizeSharedModelId(
            upstreamModel ? upstreamModel.slice(upstreamModel.indexOf("/") + 1) : id,
          ),
          ...(upstreamModel ? { upstreamModel } : {}),
          ...(typeof codeMode === "string" ? { codeMode } : {}),
        });
      }
    }
  }
  return entries;
}

function groupBySharedModel(entries: CatalogEntry[]): Map<string, CatalogEntry[]> {
  const groups = new Map<string, CatalogEntry[]>();
  for (const entry of entries) {
    const group = groups.get(entry.groupKey) ?? [];
    group.push(entry);
    groups.set(entry.groupKey, group);
  }
  return groups;
}

describe("bundled shared upstream model catalogs", () => {
  // Read lazily: the non-isolated contract runner shares one process, so manifest
  // IO belongs inside the tests rather than in collection.
  let cached: CatalogEntry[] | undefined;
  const readEntries = (): CatalogEntry[] => (cached ??= collectCatalogEntries());

  it("resolves every declared upstream model ref to another bundled catalog row", () => {
    const entries = readEntries();
    const refs = new Set(entries.map((entry) => entry.ref));
    const unresolved = entries
      .filter(
        ({ upstreamModel, ref }) =>
          upstreamModel && (upstreamModel === ref || !refs.has(upstreamModel)),
      )
      .map(({ ref, upstreamModel }) => `${ref} -> ${upstreamModel}`)
      .toSorted();

    expect(unresolved).toEqual([]);
  });

  it("declares the code-mode tier on every catalog row that ships a shared model", () => {
    // A silent sibling would change tools.codeMode: "auto" for the same model.
    const silent: string[] = [];
    for (const [groupKey, group] of groupBySharedModel(readEntries())) {
      if (group.length < 2 || !group.some((entry) => entry.codeMode)) {
        continue;
      }
      const declared = group
        .filter((entry) => entry.codeMode)
        .map((entry) => `${entry.ref}=${entry.codeMode}`)
        .toSorted()
        .join(", ");
      for (const entry of group.filter((candidate) => !candidate.codeMode)) {
        silent.push(`${entry.ref} (shared model ${groupKey}; siblings declare ${declared})`);
      }
    }

    expect(silent.toSorted()).toEqual([]);
  });

  it("keeps code-mode tiers out of plugin source so shared-model checks can see them", () => {
    const plugins = listBundledPluginFiles()
      .filter((file) => file.endsWith(".ts") && !file.includes(".test."))
      .filter((file) =>
        CODE_MODE_TIER_LITERAL.test(fs.readFileSync(path.join(repoRoot, file), "utf8")),
      )
      .map((file) => file.split("/")[1] as string);

    expect([...new Set(plugins)].toSorted()).toEqual(UNCONVERTED_SOURCE_CATALOG_PLUGINS);
  });
});
