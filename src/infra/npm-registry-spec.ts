export function validateRegistryNpmSpec(rawSpec: string): string | null {
  const spec = rawSpec.trim();
  if (!spec) {
    return "missing npm spec";
  }
  if (/\s/.test(spec)) {
    return "unsupported npm spec: whitespace is not allowed";
  }
  // Registry-only: no URLs, git, file, or alias protocols.
  // Keep strict: this runs on the gateway host.
  if (spec.includes("://")) {
    return "unsupported npm spec: URLs are not allowed";
  }
  if (spec.includes("#")) {
    return "unsupported npm spec: git refs are not allowed";
  }
  if (spec.includes(":")) {
    return "unsupported npm spec: protocol specs are not allowed";
  }

  const at = spec.lastIndexOf("@");
  const hasVersion = at > 0;
  const name = hasVersion ? spec.slice(0, at) : spec;
  const version = hasVersion ? spec.slice(at + 1) : "";

  const unscopedName = /^[a-z0-9][a-z0-9-._~]*$/;
  const scopedName = /^@[a-z0-9][a-z0-9-._~]*\/[a-z0-9][a-z0-9-._~]*$/;
  const isValidName = name.startsWith("@") ? scopedName.test(name) : unscopedName.test(name);
  if (!isValidName) {
    return "unsupported npm spec: expected <name> or <name>@<version> from the npm registry";
  }
  if (hasVersion) {
    if (!version) {
      return "unsupported npm spec: missing version/tag after @";
    }
    if (/[\\/]/.test(version)) {
      return "unsupported npm spec: invalid version/tag";
    }
  }
  return null;
}
