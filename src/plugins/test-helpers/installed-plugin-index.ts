import fs from "node:fs";
import path from "node:path";
import type { PluginInstallRecord } from "../../config/types.plugins.js";
import type { PluginCandidate } from "../discovery.js";
import { refreshPersistedInstalledPluginIndex } from "../installed-plugin-index-store-write.js";

/** Seed fixture state without adding an unleased production record writer. */
export async function seedInstalledPluginIndex(
  records: Record<string, PluginInstallRecord>,
  options: Omit<
    Parameters<typeof refreshPersistedInstalledPluginIndex>[0],
    "reason" | "installRecords" | "lease"
  > = {},
): Promise<void> {
  refreshPersistedInstalledPluginIndex({
    ...options,
    reason: "source-changed",
    installRecords: records,
  });
}

export function createInstalledPluginIndexCandidate(
  rootDir: string,
  options: { id?: string; configPaths?: readonly string[] } = {},
): PluginCandidate {
  const id = options.id ?? "demo";
  fs.writeFileSync(
    path.join(rootDir, "index.ts"),
    "throw new Error('runtime entry should not load while persisting installed plugin index');\n",
    "utf8",
  );
  fs.writeFileSync(
    path.join(rootDir, "openclaw.plugin.json"),
    JSON.stringify({
      id,
      name: id === "demo" ? "Demo" : "Next Demo",
      configSchema: { type: "object" },
      providers: [id],
      ...(options.configPaths ? { activation: { onConfigPaths: options.configPaths } } : {}),
    }),
    "utf8",
  );
  return {
    idHint: id,
    source: path.join(rootDir, "index.ts"),
    rootDir,
    origin: "global",
  };
}
