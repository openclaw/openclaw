import { createJiti } from "jiti";
import {
  loadPluginBoundaryModuleWithJiti,
  resolvePluginRuntimeModulePath,
  resolvePluginRuntimeRecord,
} from "./runtime-plugin-boundary.js";

const MATRIX_PLUGIN_ID = "matrix";

type MatrixModule = typeof import("../../../extensions/matrix/runtime-api.js");

type MatrixPluginRecord = {
  rootDir?: string;
  source: string;
};

let cachedModulePath: string | null = null;
let cachedModule: MatrixModule | null = null;

const jitiLoaders = new Map<boolean, ReturnType<typeof createJiti>>();

function resolveMatrixPluginRecord(): MatrixPluginRecord | null {
  return resolvePluginRuntimeRecord(MATRIX_PLUGIN_ID) as MatrixPluginRecord | null;
}

function resolveMatrixRuntimeModulePath(record: MatrixPluginRecord): string | null {
  return resolvePluginRuntimeModulePath(record, "runtime-api");
}

function loadMatrixModule(): MatrixModule | null {
  const record = resolveMatrixPluginRecord();
  if (!record) {
    return null;
  }
  const modulePath = resolveMatrixRuntimeModulePath(record);
  if (!modulePath) {
    return null;
  }
  if (cachedModule && cachedModulePath === modulePath) {
    return cachedModule;
  }
  const loaded = loadPluginBoundaryModuleWithJiti<MatrixModule>(modulePath, jitiLoaders);
  cachedModulePath = modulePath;
  cachedModule = loaded;
  return loaded;
}

export function setMatrixThreadBindingIdleTimeoutBySessionKey(
  ...args: Parameters<MatrixModule["setMatrixThreadBindingIdleTimeoutBySessionKey"]>
): ReturnType<MatrixModule["setMatrixThreadBindingIdleTimeoutBySessionKey"]> {
  const fn = loadMatrixModule()?.setMatrixThreadBindingIdleTimeoutBySessionKey;
  if (typeof fn !== "function") {
    return [];
  }
  return fn(...args);
}

export function setMatrixThreadBindingMaxAgeBySessionKey(
  ...args: Parameters<MatrixModule["setMatrixThreadBindingMaxAgeBySessionKey"]>
): ReturnType<MatrixModule["setMatrixThreadBindingMaxAgeBySessionKey"]> {
  const fn = loadMatrixModule()?.setMatrixThreadBindingMaxAgeBySessionKey;
  if (typeof fn !== "function") {
    return [];
  }
  return fn(...args);
}
