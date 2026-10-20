import path from "node:path";
import { validRange } from "semver";

export function looksLikeLocalInstallSpec(spec: string, knownSuffixes: readonly string[]): boolean {
  return (
    spec.startsWith(".") ||
    spec.startsWith("~") ||
    path.isAbsolute(spec) ||
    knownSuffixes.some((suffix) => spec.endsWith(suffix))
  );
}

export function isRegistrySourceInstallSpec(spec: string): boolean {
  // Version-only deduplication is reserved for positively identified registry
  // specs. Explicit and unknown npm source syntax must prove build identity.
  // npm-package-arg gives unscoped archive names precedence over package names.
  const archive = /[.](?:tgz|tar[.]gz|tar)$/iu;
  const packageName = /^(?:@[a-z0-9_][a-z0-9._-]*\/)?[a-z0-9_][a-z0-9._-]*$/iu;
  const value = spec.trim();
  const separator = value.indexOf("@", 1);
  const name = separator > 0 ? value.slice(0, separator) : value;
  const selector = separator > 0 ? value.slice(separator + 1).trim() : "";

  if (value.startsWith("npm:") || selector.startsWith("npm:")) {
    // An alias can replace the underlying package at the same version.
    return false;
  }
  if (!packageName.test(name) || (!name.startsWith("@") && archive.test(name))) {
    return false;
  }
  // File suffixes take precedence over dist-tags in npm's resolve contract.
  // npm treats leading dots as paths and accepts tags unchanged by encodeURIComponent.
  return (
    !selector.startsWith(".") &&
    !archive.test(selector) &&
    (validRange(selector, true) !== null || encodeURIComponent(selector) === selector)
  );
}
