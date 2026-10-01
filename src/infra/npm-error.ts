import { validRange } from "semver";
import { UPDATE_NPM_ERROR_CODES } from "../../packages/gateway-protocol/src/update-run-vocabulary.js";
import { parseRegistryNpmSpec } from "./npm-registry-spec.js";

const NPM_FAILURE_CODES = [
  ...UPDATE_NPM_ERROR_CODES,
  "EPERM",
  "EEXIST",
  "ENOENT",
  "ENOTFOUND",
  "EAI_AGAIN",
  "ECONNREFUSED",
  "ENETUNREACH",
  "EHOSTUNREACH",
  "EPIPE",
  "E401",
  "E403",
  "EOTP",
  "ERESOLVE",
  "EBADENGINE",
  "EUSAGE",
  "EOVERRIDE",
  "EINVALIDTAGNAME",
  "EUNSUPPORTEDPROTOCOL",
  "CERT_HAS_EXPIRED",
  "UNABLE_TO_VERIFY_LEAF_SIGNATURE",
  "SELF_SIGNED_CERT_IN_CHAIN",
  "DEPTH_ZERO_SELF_SIGNED_CERT",
] as const;
export type NpmFailureCode = (typeof NPM_FAILURE_CODES)[number];

export function npmFailureCode(value: string | undefined): NpmFailureCode {
  return NPM_FAILURE_CODES.find((code) => code === value) ?? "unknown";
}

/** Shared npm error classification for install, metadata, and permission failures. */
export function parseNpmErrorCode(text: string): NpmFailureCode {
  const explicit = /\bnpm (?:ERR!|error) code (\S+)/u.exec(text)?.[1];
  if (explicit) {
    return npmFailureCode(explicit);
  }
  if (
    /No version matching "[^"\n]+" found for specifier "[^"\n]+" \(but package exists\)/u.test(text)
  ) {
    return "ETARGET";
  }
  if (/Integrity check failed for tarball:/u.test(text)) {
    return "EINTEGRITY";
  }
  if (/404 - GET |GET \S+ - 404\b/u.test(text)) {
    return "E404";
  }
  return (
    text
      .match(/\b[A-Z][A-Z0-9_]+\b/gu)
      ?.map(npmFailureCode)
      .find((code) => code !== "unknown") ??
    (/is not in this registry/iu.test(text) ? "E404" : "unknown")
  );
}

/** Admit registry specs only; diagnostic URLs, local paths, and shell text stay private. */
export function npmFailurePackageSpec(text: string): string | undefined {
  const bunTarget =
    /No version matching "([^"\n]+)" found for specifier "([^"\n]+)" \(but package exists\)/u.exec(
      text,
    );
  const spec =
    (bunTarget ? `${bunTarget[2]}@${bunTarget[1]}` : undefined) ??
    /No matching version found for (.+)\.(?:\r?$)/mu.exec(text)?.[1] ??
    /(?:404\s+|The requested resource )['"]([^'"]+)['"]/u.exec(text)?.[1] ??
    /(?:tarball|cached) data for (\S+) \(/u.exec(text)?.[1] ??
    /Integrity check failed for tarball: (\S+)/u.exec(text)?.[1] ??
    /^(?:error: )?(\S+@\S+) failed to resolve$/mu.exec(text)?.[1];
  return spec && npmFailurePackageName(spec) ? spec : undefined;
}

export function npmFailurePackageName(spec: string): string | undefined {
  if (spec.length > 200) {
    return undefined;
  }
  const parsed = parseRegistryNpmSpec(spec);
  if (parsed) {
    return parsed.name;
  }
  const separator = spec.indexOf("@", 1);
  return separator > 0 && validRange(spec.slice(separator + 1))
    ? parseRegistryNpmSpec(spec.slice(0, separator))?.name
    : undefined;
}
