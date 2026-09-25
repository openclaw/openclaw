// Hook module loader imports hook modules from file URLs with cache isolation.
import { pathToFileURL } from "node:url";

type ModuleNamespace = Record<string, unknown>;
type GenericFunction = (...args: never[]) => unknown;

export async function importFileModule(params: {
  modulePath: string;
  cacheBust?: boolean;
  nowMs?: number;
}): Promise<ModuleNamespace> {
  const url = pathToFileURL(params.modulePath).href;
  const specifier = params.cacheBust ? `${url}?t=${params.nowMs ?? Date.now()}` : url;
  return (await import(specifier)) as ModuleNamespace;
}

// oxlint-disable-next-line typescript/no-unnecessary-type-parameters -- Dynamic module exports are typed by the caller.
export function resolveFunctionModuleExport<T extends GenericFunction>(params: {
  mod: ModuleNamespace;
  exportName?: string;
  fallbackExportNames?: string[];
}): T | undefined {
  const explicitExport = params.exportName?.trim();
  if (explicitExport) {
    const candidate = params.mod[explicitExport];
    return typeof candidate === "function" ? (candidate as T) : undefined;
  }
  const fallbacks = params.fallbackExportNames ?? ["default"];
  for (const exportName of fallbacks) {
    const candidate = params.mod[exportName];
    if (typeof candidate === "function") {
      return candidate as T;
    }
  }
  return undefined;
}
