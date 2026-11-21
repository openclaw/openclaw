import { containsAsciiControlCharacter } from "@openclaw/normalization-core/string-normalization";
import { validRange } from "semver";
import { normalizeSupportDiagnosticErrorCode } from "../logging/diagnostic-support-redaction.js";
import { redactSensitiveText } from "../logging/redact.js";
import { parseRegistryNpmSpec } from "./npm-registry-spec.js";

/** Shared npm error classification for install, metadata, and permission failures. */
export function parseNpmErrorCode(text: string): string | undefined {
  const explicit = /\bnpm (?:ERR!|error) code ([A-Z][A-Z0-9_]+)/u.exec(text)?.[1];
  if (explicit) {
    // Local diagnostics retain custom codes; public npm facts apply the shared allowlist.
    return explicit;
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
      ?.map(normalizeSupportDiagnosticErrorCode)
      .find(Boolean) ?? (/is not in this registry/iu.test(text) ? "E404" : undefined)
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
  if (
    spec.length > 200 ||
    containsAsciiControlCharacter(spec) ||
    /[\u2028\u2029]/u.test(spec) ||
    redactSensitiveText(spec, { mode: "tools" }) !== spec
  ) {
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
