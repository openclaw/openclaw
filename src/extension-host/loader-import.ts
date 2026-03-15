import fs from "node:fs";
import path from "node:path";
import { openBoundaryFileSync } from "../infra/boundary-file-read.js";
import type { PluginRecord } from "../plugins/registry.js";

export function importExtensionHostPluginModule(params: {
  rootDir: string;
  source: string;
  origin: PluginRecord["origin"];
  loadModule: (safeSource: string) => unknown;
}):
  | {
      ok: true;
      module: unknown;
      safeSource: string;
    }
  | {
      ok: false;
      message: string;
      error?: unknown;
    } {
  const pluginRoot = safeRealpathOrResolve(params.rootDir);
  const opened = openBoundaryFileSync({
    absolutePath: params.source,
    rootPath: pluginRoot,
    boundaryLabel: "plugin root",
    rejectHardlinks: params.origin !== "bundled",
    skipLexicalRootCheck: true,
  });
  if (!opened.ok) {
    return {
      ok: false,
      message: "plugin entry path escapes plugin root or fails alias checks",
    };
  }

  const safeSource = opened.path;
  fs.closeSync(opened.fd);
  try {
    return {
      ok: true,
      module: params.loadModule(safeSource),
      safeSource,
    };
  } catch (error) {
    return {
      ok: false,
      message: "failed to load plugin",
      error,
    };
  }
}

function safeRealpathOrResolve(value: string): string {
  try {
    return fs.realpathSync(value);
  } catch {
    return path.resolve(value);
  }
}
