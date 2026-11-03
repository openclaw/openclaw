/** Resolve checkout declarations in precedence order; callers may prepend another source. */
export function resolveRepositoryNodeRequirement(
  files: Readonly<Record<string, string | undefined>>,
): string | undefined {
  for (const name of [".nvmrc", ".node-version"]) {
    const value = files[name]
      ?.split("\n")
      .map((line) => line.split("#", 1)[0]?.trim())
      .find(Boolean);
    if (value) {
      return value;
    }
  }
  const tools = files[".tool-versions"]?.match(/^\s*(?:nodejs|node)\s+(\S+)/mu)?.[1];
  if (tools) {
    return tools;
  }
  const mise = files["mise.toml"];
  const section = mise?.split(/^\s*\[tools\][ \t]*(?:#.*)?$/mu)[1]?.split(/^\s*\[/mu)[0];
  const node = section?.match(/^\s*node\s*=\s*["']([^"']+)["']/mu)?.[1];
  if (node) {
    return node;
  }
  const manifest = files["package.json"];
  if (!manifest) {
    return undefined;
  }
  const requirement: unknown = JSON.parse(manifest)?.engines?.node;
  return typeof requirement === "string" && requirement.trim() ? requirement.trim() : undefined;
}
