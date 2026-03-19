import fs from "node:fs";
import path from "node:path";
import { createJiti } from "jiti";
import type { OpenClawConfig } from "../config/config.js";
import {
  loadPluginManifestRegistry,
  type PluginManifestRecord,
} from "../plugins/manifest-registry.js";
import { openBoundaryFileSync } from "./boundary-file-read.js";

const MATRIX_PLUGIN_ID = "matrix";
const MATRIX_HELPER_CANDIDATES = [
  "legacy-crypto-inspector.ts",
  "legacy-crypto-inspector.js",
  path.join("dist", "legacy-crypto-inspector.js"),
] as const;

export const MATRIX_LEGACY_CRYPTO_INSPECTOR_UNAVAILABLE_MESSAGE =
  "Legacy Matrix encrypted state was detected, but the Matrix plugin helper is unavailable. Install or repair @openclaw/matrix so OpenClaw can inspect the old rust crypto store before upgrading.";

type MatrixLegacyCryptoInspectorParams = {
  cryptoRootDir: string;
  userId: string;
  deviceId: string;
  log?: (message: string) => void;
};

type MatrixLegacyCryptoInspectorResult = {
  deviceId: string | null;
  roomKeyCounts: {
    total: number;
    backedUp: number;
  } | null;
  backupVersion: string | null;
  decryptionKeyBase64: string | null;
};

export type MatrixLegacyCryptoInspector = (
  params: MatrixLegacyCryptoInspectorParams,
) => Promise<MatrixLegacyCryptoInspectorResult>;

function resolveMatrixPluginRecord(params: {
  cfg: OpenClawConfig;
  env?: NodeJS.ProcessEnv;
  workspaceDir?: string;
}): PluginManifestRecord | null {
  const registry = loadPluginManifestRegistry({
    config: params.cfg,
    workspaceDir: params.workspaceDir,
    env: params.env,
  });
  return registry.plugins.find((plugin) => plugin.id === MATRIX_PLUGIN_ID) ?? null;
}

type MatrixLegacyCryptoInspectorPathResolution =
  | { status: "ok"; helperPath: string }
  | { status: "missing" }
  | { status: "unsafe"; candidatePath: string };

function resolveMatrixLegacyCryptoInspectorPath(params: {
  cfg: OpenClawConfig;
  env?: NodeJS.ProcessEnv;
  workspaceDir?: string;
}): MatrixLegacyCryptoInspectorPathResolution {
  const plugin = resolveMatrixPluginRecord(params);
  if (!plugin) {
    return { status: "missing" };
  }
  for (const relativePath of MATRIX_HELPER_CANDIDATES) {
    const candidatePath = path.join(plugin.rootDir, relativePath);
    const opened = openBoundaryFileSync({
      absolutePath: candidatePath,
      rootPath: plugin.rootDir,
      boundaryLabel: "plugin root",
      rejectHardlinks: plugin.origin !== "bundled",
      allowedType: "file",
    });
    if (opened.ok) {
      fs.closeSync(opened.fd);
      return { status: "ok", helperPath: opened.path };
    }
    if (opened.reason !== "path") {
      return { status: "unsafe", candidatePath };
    }
  }
  return { status: "missing" };
}

export function isMatrixLegacyCryptoInspectorAvailable(params: {
  cfg: OpenClawConfig;
  env?: NodeJS.ProcessEnv;
  workspaceDir?: string;
}): boolean {
  return resolveMatrixLegacyCryptoInspectorPath(params).status === "ok";
}

let jitiLoader: ReturnType<typeof createJiti> | null = null;
const inspectorCache = new Map<string, Promise<MatrixLegacyCryptoInspector>>();

function getJiti() {
  if (!jitiLoader) {
    jitiLoader = createJiti(import.meta.url, {
      interopDefault: false,
      extensions: [".ts", ".tsx", ".mts", ".cts", ".js", ".mjs", ".cjs", ".json"],
    });
  }
  return jitiLoader;
}

function isObjectRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function resolveInspectorExport(loaded: unknown): MatrixLegacyCryptoInspector | null {
  if (!isObjectRecord(loaded)) {
    return null;
  }
  const directInspector = loaded.inspectLegacyMatrixCryptoStore;
  if (typeof directInspector === "function") {
    return directInspector as MatrixLegacyCryptoInspector;
  }
  const directDefault = loaded.default;
  if (typeof directDefault === "function") {
    return directDefault as MatrixLegacyCryptoInspector;
  }
  if (!isObjectRecord(directDefault)) {
    return null;
  }
  const nestedInspector = directDefault.inspectLegacyMatrixCryptoStore;
  return typeof nestedInspector === "function"
    ? (nestedInspector as MatrixLegacyCryptoInspector)
    : null;
}

export async function loadMatrixLegacyCryptoInspector(params: {
  cfg: OpenClawConfig;
  env?: NodeJS.ProcessEnv;
  workspaceDir?: string;
}): Promise<MatrixLegacyCryptoInspector> {
  const resolution = resolveMatrixLegacyCryptoInspectorPath(params);
  if (resolution.status === "missing") {
    throw new Error(MATRIX_LEGACY_CRYPTO_INSPECTOR_UNAVAILABLE_MESSAGE);
  }
  if (resolution.status === "unsafe") {
    throw new Error(
      `Matrix plugin helper path is unsafe: ${resolution.candidatePath}. Reinstall @openclaw/matrix and try again.`,
    );
  }
  const helperPath = resolution.helperPath;

  const cached = inspectorCache.get(helperPath);
  if (cached) {
    return await cached;
  }

  const pending = (async () => {
    const loaded: unknown = await getJiti().import(helperPath);
    const inspectLegacyMatrixCryptoStore = resolveInspectorExport(loaded);
    if (!inspectLegacyMatrixCryptoStore) {
      throw new Error(
        `Matrix plugin helper at ${helperPath} does not export inspectLegacyMatrixCryptoStore(). Reinstall @openclaw/matrix and try again.`,
      );
    }
    return inspectLegacyMatrixCryptoStore;
  })();
  inspectorCache.set(helperPath, pending);
  try {
    return await pending;
  } catch (err) {
    inspectorCache.delete(helperPath);
    throw err;
  }
}
