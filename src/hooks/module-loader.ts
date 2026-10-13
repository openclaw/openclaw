type ModuleNamespace = Record<string, unknown>;
type GenericFunction = (...args: never[]) => unknown;

// oxlint-disable-next-line typescript/no-unnecessary-type-parameters -- Dynamic module exports are typed by the caller.
export function resolveFunctionModuleExport<T extends GenericFunction>(params: {
  mod: ModuleNamespace;
  exportName?: string;
  fallbackExportNames?: string[];
}): T | undefined {
  const explicitExport = params.exportName?.trim();
  const exportNames = explicitExport
    ? [explicitExport]
    : (params.fallbackExportNames ?? ["default"]);
  for (const exportName of exportNames) {
    const candidate = params.mod[exportName];
    if (typeof candidate === "function") {
      return candidate as T;
    }
  }
  return undefined;
}
