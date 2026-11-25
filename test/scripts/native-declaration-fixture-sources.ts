import { collectRuntimeImportClosure } from "../../scripts/lib/runtime-import-closure.mts";

let sources: readonly string[] | undefined;

/** Copy the emitter's real dependencies even when its runtime reaches outside scripts/. */
export function resolveNativeDeclarationFixtureSources(): readonly string[] {
  return (sources ??= collectRuntimeImportClosure(
    process.cwd(),
    ["scripts/lib/native-declaration-emitter.mts"],
    { includeDynamicImports: true },
  ));
}
