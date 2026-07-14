import { isOperatorScope, type OperatorScope } from "../gateway/operator-scopes.js";
import { canonicalizePathForSecurity } from "../gateway/security-path.js";
import type { PluginControlUiEntryPoint } from "./host-hooks.js";
import {
  normalizeHostHookString,
  normalizeHostHookStringList,
  normalizeOptionalHostHookString,
} from "./registry-registrar-normalization.js";
import type { PluginRegistryState } from "./registry-state.js";
import type { PluginRecord } from "./registry-types.js";

const surfaces = new Set<PluginControlUiEntryPoint["surface"]>(["app-nav"]);
const openModes = new Set<NonNullable<PluginControlUiEntryPoint["openMode"]>>([
  "in-app",
  "same-window",
  "new-window",
]);

function hasControlCharacter(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code <= 0x1f || code === 0x7f) {
      return true;
    }
  }
  return false;
}

function normalizePath(pluginId: string, value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const pathValue = value.trim();
  if (
    !pathValue ||
    !pathValue.startsWith("/") ||
    pathValue.startsWith("//") ||
    pathValue.includes("\\") ||
    pathValue.includes("?") ||
    pathValue.includes("#") ||
    hasControlCharacter(pathValue) ||
    /^(?:[a-z][a-z0-9+.-]*:)/i.test(pathValue) ||
    /%(?:2f|5c)/i.test(pathValue)
  ) {
    return null;
  }
  const pluginRoot = `/plugins/${pluginId}`;
  if (pathValue !== pluginRoot && !pathValue.startsWith(`${pluginRoot}/`)) {
    return null;
  }
  const canonicalPluginRoot = canonicalizePathForSecurity(pluginRoot).canonicalPath;
  const canonical = canonicalizePathForSecurity(pathValue);
  return !canonical.malformedEncoding &&
    !canonical.decodePassLimitReached &&
    canonical.candidates.every(
      (candidate) =>
        candidate === canonicalPluginRoot || candidate.startsWith(`${canonicalPluginRoot}/`),
    )
    ? pathValue
    : null;
}

export function createControlUiEntryPointRegistrar(state: PluginRegistryState) {
  const { registry, pushDiagnostic } = state;
  return (record: PluginRecord, entryPoint: PluginControlUiEntryPoint): void => {
    const id = normalizeHostHookString(entryPoint.id);
    const label = normalizeHostHookString(entryPoint.label);
    const description = normalizeOptionalHostHookString(entryPoint.description);
    const requiredScopes = normalizeHostHookStringList(entryPoint.requiredScopes);
    const surface = typeof entryPoint.surface === "string" ? entryPoint.surface : "";
    const path = normalizePath(record.id, entryPoint.path);
    const openMode =
      entryPoint.openMode === undefined || entryPoint.openMode === null
        ? "in-app"
        : typeof entryPoint.openMode === "string"
          ? entryPoint.openMode
          : "";
    if (
      !id ||
      !label ||
      !surfaces.has(surface as PluginControlUiEntryPoint["surface"]) ||
      !openModes.has(openMode as NonNullable<PluginControlUiEntryPoint["openMode"]>) ||
      !path ||
      description === "" ||
      requiredScopes === null
    ) {
      pushDiagnostic({
        level: "error",
        pluginId: record.id,
        source: record.source,
        message:
          "control UI entry point registration requires id, surface, label, plugin-owned path, and valid optional fields",
      });
      return;
    }
    if (requiredScopes !== undefined) {
      const unknownScope = requiredScopes.find((scope) => !isOperatorScope(scope));
      if (unknownScope !== undefined) {
        pushDiagnostic({
          level: "error",
          pluginId: record.id,
          source: record.source,
          message: `control UI entry point requiredScopes contains unknown operator scope: ${unknownScope}`,
        });
        return;
      }
    }
    if (
      registry.controlUiEntryPoints.some(
        (entry) => entry.pluginId === record.id && entry.entryPoint.id === id,
      )
    ) {
      pushDiagnostic({
        level: "error",
        pluginId: record.id,
        source: record.source,
        message: `control UI entry point already registered: ${id}`,
      });
      return;
    }
    registry.controlUiEntryPoints.push({
      pluginId: record.id,
      pluginName: record.name,
      entryPoint: {
        ...entryPoint,
        id,
        surface: surface as PluginControlUiEntryPoint["surface"],
        label,
        path,
        openMode: openMode as NonNullable<PluginControlUiEntryPoint["openMode"]>,
        ...(description !== undefined ? { description } : {}),
        ...(requiredScopes !== undefined
          ? { requiredScopes: requiredScopes as OperatorScope[] }
          : {}),
      },
      source: record.source,
      rootDir: record.rootDir,
    });
  };
}
