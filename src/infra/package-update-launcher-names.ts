import path from "node:path";

/**
 * The global launchers a package update publishes, by package and CLI name (with any
 * `.cmd`/`.ps1` variant). A leaf so the native stage and the swap can share it.
 */
export function resolvePackageUpdateLauncherNames(
  packageName: string,
  entries?: readonly string[],
) {
  const names = new Set([packageName, "openclaw"]);
  return (
    entries?.filter((entry) => names.has(entry) || names.has(path.parse(entry).name)) ?? [...names]
  ).toSorted();
}
