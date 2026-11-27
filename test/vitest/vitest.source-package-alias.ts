import path from "node:path";

/** Resolve workspace package exports to the source files tested in this checkout. */
export function createVitestSourcePackageAliases(repoRoot: string) {
  function sourcePackageAlias(packageId: string, subpath?: string) {
    return {
      find: `@openclaw/${packageId}${subpath ? `/${subpath}` : ""}`,
      replacement: path.join(
        repoRoot,
        "packages",
        packageId,
        "src",
        ...(subpath ? subpath.split("/") : ["index"]).map((part, index, parts) =>
          index === parts.length - 1 ? `${part}.ts` : part,
        ),
      ),
    };
  }

  function sourcePackageAliasesFromExports(packageId: string, exports: Record<string, unknown>) {
    return Object.keys(exports)
      .map((exportKey) => (exportKey === "." ? undefined : exportKey.slice(2)))
      .filter((subpath) => subpath === undefined || (subpath && !subpath.includes("..")))
      .toSorted((a, b) => (a ?? "").localeCompare(b ?? ""))
      .map((subpath) => sourcePackageAlias(packageId, subpath));
  }

  return { sourcePackageAlias, sourcePackageAliasesFromExports };
}
