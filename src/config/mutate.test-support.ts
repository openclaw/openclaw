// Snapshot/include fixtures and reversible publication faults for mutation tests.
import fsNode from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { onTestFinished, vi } from "vitest";
import { asResolvedSourceConfig, asRuntimeConfig } from "./materialize.js";
import type { ConfigFileSnapshot, OpenClawConfig } from "./types.js";

export function createSnapshot(params: {
  hash: string;
  path?: string;
  parsed?: unknown;
  sourceConfig: OpenClawConfig;
  runtimeConfig?: OpenClawConfig;
}): ConfigFileSnapshot {
  const runtimeConfig = asRuntimeConfig(params.runtimeConfig ?? params.sourceConfig);
  const sourceConfig = asResolvedSourceConfig(params.sourceConfig);
  const parsed = params.parsed ?? params.sourceConfig;
  return {
    path: params.path ?? "/tmp/openclaw.json",
    exists: true,
    raw: `${JSON.stringify(parsed, null, 2)}\n`,
    parsed,
    sourceConfig,
    resolved: sourceConfig,
    valid: true,
    runtimeConfig,
    config: runtimeConfig,
    hash: params.hash,
    issues: [],
    warnings: [],
    legacyIssues: [],
  };
}

export async function createPluginIncludeFixture(home: string) {
  const configPath = path.join(home, ".openclaw", "openclaw.json");
  const pluginsPath = path.join(home, ".openclaw", "config", "plugins.json5");
  await fs.mkdir(path.dirname(pluginsPath), { recursive: true });
  await fs.writeFile(
    configPath,
    `${JSON.stringify({ plugins: { $include: "./config/plugins.json5" } }, null, 2)}\n`,
    "utf-8",
  );
  return { configPath, pluginsPath };
}

export async function resolveIncludeTarget(filePath: string): Promise<string> {
  return path.join(await fs.realpath(path.dirname(filePath)), path.basename(filePath));
}

export function mockIncludeRollbackRename(
  targetPath: string,
  method: "rename" | "permission-fallback",
): void {
  const rename = fsNode.renameSync;
  let targetRenames = 0;
  const renameSpy = vi.spyOn(fsNode, "renameSync").mockImplementation((from, to) => {
    if (to === targetPath && ++targetRenames === 2 && method === "permission-fallback") {
      throw Object.assign(new Error("rollback sharing violation"), { code: "EPERM" });
    }
    rename(from, to);
  });
  onTestFinished(() => renameSpy.mockRestore());
}
