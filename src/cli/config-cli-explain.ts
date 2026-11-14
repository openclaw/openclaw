import type { ConfigIncludeOwnership } from "../config/includes.js";
import { REDACTED_SENTINEL } from "../config/redact-sentinel.js";
import {
  getAuthoredConfigSecretRef,
  getResolvedConfigEnvSecretRef,
} from "../config/resolution-facts.js";
import type { ConfigFileSnapshot } from "../config/types.openclaw.js";
import { coerceSecretRef, type SecretRef } from "../config/types.secrets.js";
import { formatConcreteConfigPath, type ConcreteConfigPathSegment } from "../shared/dot-path.js";
import { getAtPath } from "./config-cli-path.js";

/** Where a single config leaf came from in the local snapshot. */
export type ConfigExplainSource = "authored" | "default" | "unset" | "include" | "ambiguous";

export type ConfigExplainInclude = {
  /** Resolved include file path(s) that contributed to this leaf. */
  files: string[];
  kind: "single" | "multiple";
  hasSiblingOverrides: boolean;
  /** Dot-path of the `$include` directive that owns this leaf. */
  boundaryPath: string;
  /** True when ownership is not a sole single-file owner. */
  ambiguous: boolean;
};

export type ConfigExplainSecretRef = {
  source: SecretRef["source"];
  provider: string;
  /** Always redacted — matches `config get` identifier redaction. */
  id: typeof REDACTED_SENTINEL;
  state: "pending" | "resolved" | "structured";
};

export type ConfigExplainResult = {
  path: string;
  /** Redacted runtime value when present on the runtime snapshot. */
  runtimeValue?: unknown;
  authoredPresent: boolean;
  source: ConfigExplainSource;
  include?: ConfigExplainInclude;
  secretRef?: ConfigExplainSecretRef;
  /** Optional operator note when provenance is incomplete or ambiguous. */
  note?: string;
};

function isPathPrefix(prefix: readonly string[], candidate: readonly string[]): boolean {
  return (
    prefix.length <= candidate.length &&
    prefix.every((segment, index) => segment === candidate[index])
  );
}

function includeFiles(entry: ConfigIncludeOwnership): string[] {
  if (entry.targetPaths && entry.targetPaths.length > 0) {
    return [...entry.targetPaths];
  }
  return entry.targetPath ? [entry.targetPath] : [];
}

function isSoleIncludeOwner(entry: ConfigIncludeOwnership): boolean {
  return entry.kind === "single" && !entry.hasSiblingOverrides && Boolean(entry.targetPath);
}

/**
 * Finds include provenance that covers `pathTokens`. Deepest matching entries win only when
 * every enclosing cover is itself a sole owner — otherwise an ancestor merge/sibling override
 * could have contributed, matching include-write-boundary precedence (66714b86).
 */
export function resolveIncludeProvenanceForPath(params: {
  pathTokens: readonly string[];
  provenance: readonly ConfigIncludeOwnership[] | undefined;
}): ConfigExplainInclude | undefined {
  const provenance = params.provenance;
  if (!provenance || provenance.length === 0) {
    return undefined;
  }
  const covering = provenance.filter((entry) => isPathPrefix(entry.path, params.pathTokens));
  if (covering.length === 0) {
    return undefined;
  }
  const maxDepth = Math.max(...covering.map((entry) => entry.path.length));
  const deepest = covering.filter((entry) => entry.path.length === maxDepth);
  const enclosing = covering.filter((entry) =>
    deepest.some(
      (deep) => entry.path.length < deep.path.length && isPathPrefix(entry.path, deep.path),
    ),
  );
  // Ancestor that is not a sole owner can merge/override nested include values.
  const enclosingNonSole = enclosing.some((entry) => !isSoleIncludeOwner(entry));
  const relevant = enclosingNonSole ? [...enclosing, ...deepest] : deepest;
  const files = [...new Set(relevant.flatMap(includeFiles))];
  const kind = relevant.some((entry) => entry.kind === "multiple")
    ? "multiple"
    : files.length > 1
      ? "multiple"
      : "single";
  const hasSiblingOverrides = relevant.some((entry) => entry.hasSiblingOverrides);
  const sole = !enclosingNonSole && deepest.length === 1 && isSoleIncludeOwner(deepest[0]!);
  const ambiguous = !sole || kind === "multiple" || hasSiblingOverrides || files.length !== 1;
  return {
    files,
    kind,
    hasSiblingOverrides,
    boundaryPath: formatConcreteConfigPath(deepest[0]!.path),
    ambiguous,
  };
}

function redactSecretRefSummary(
  ref: SecretRef,
  state: ConfigExplainSecretRef["state"],
): ConfigExplainSecretRef {
  return {
    source: ref.source,
    provider: ref.provider,
    id: REDACTED_SENTINEL,
    state,
  };
}

/**
 * Resolves SecretRef identity for a path without printing the secret id or value.
 * Uses recorded resolution facts for loaded strings (including known-empty) and never
 * reparses decoded literals such as `${LITERAL}` from `$${LITERAL}` (5f6de37e).
 */
export function resolveExplainSecretRef(params: {
  /** Canonical fact-lookup path (formatConcreteConfigPath of parsed tokens). */
  path: string;
  factOwner: unknown;
  authoredValue: unknown;
  runtimeValue: unknown;
}): ConfigExplainSecretRef | undefined {
  const pending = getAuthoredConfigSecretRef(params.factOwner, params.path);
  if (pending) {
    return redactSecretRefSummary(pending, "pending");
  }
  const resolved = getResolvedConfigEnvSecretRef(params.factOwner, params.path);
  if (resolved) {
    return redactSecretRefSummary(resolved, "resolved");
  }

  const candidate = params.authoredValue ?? params.runtimeValue;
  // Loaded strings answer only from recorded facts (pending/resolved above).
  // Known-empty facts mean "not a reference"; never invent one from a decoded literal.
  if (typeof candidate === "string") {
    return undefined;
  }

  // Structured SecretRef objects may be inspected even when facts are absent.
  // Never reparse decoded string literals into SecretRefs (5f6de37e).
  const structured = coerceSecretRef(candidate);
  if (structured) {
    return redactSecretRefSummary(structured, "structured");
  }
  return undefined;
}

/**
 * Builds a single-path provenance explanation from an already-loaded config snapshot.
 * Prefers `authoredConfig` over `sourceConfig` for authored presence (roster defaults
 * may already be materialized onto `sourceConfig`).
 *
 * Include ownership is applied only when the authored leaf is present — an include
 * boundary prefix alone does not mean an absent descendant came from that file.
 */
export function buildConfigExplainResult(params: {
  /** Operator-entered path spelling (display only). */
  path: string;
  pathTokens: readonly ConcreteConfigPathSegment[];
  snapshot: ConfigFileSnapshot;
  /** Already-redacted runtime value lookup result. */
  runtimeLookup: { found: boolean; value?: unknown };
}): ConfigExplainResult {
  const stringTokens = params.pathTokens.map(String);
  // Resolution facts are indexed by canonical paths; retain entered spelling for display.
  // Pass a source container so dotted array indices (fallbacks.0) canonicalize to fallbacks[0].
  const factPathSource =
    params.snapshot.sourceConfig ?? params.snapshot.config ?? params.snapshot.authoredConfig;
  const factPath = formatConcreteConfigPath(params.pathTokens, factPathSource);
  const authoredRoot = params.snapshot.authoredConfig ?? params.snapshot.sourceConfig;
  const authoredLookup = getAtPath(authoredRoot, stringTokens);
  const authoredPresent = authoredLookup.found;
  const include = resolveIncludeProvenanceForPath({
    pathTokens: stringTokens,
    provenance: params.snapshot.includeProvenance,
  });

  let source: ConfigExplainSource;
  let note: string | undefined;
  let includeForResult: ConfigExplainInclude | undefined;

  if (authoredPresent && include) {
    includeForResult = include;
    source = include.ambiguous ? "ambiguous" : "include";
    if (include.ambiguous) {
      note =
        "Include ownership is ambiguous (multiple files, sibling overrides, enclosing merges, or a merged include); the listed files contributed but no sole winning file is claimed.";
    }
  } else if (authoredPresent) {
    source = "authored";
    if (!params.snapshot.authoredConfig) {
      note =
        "Authored presence is taken from sourceConfig because authoredConfig was unavailable; implicit normalization may already be present on some paths.";
    }
  } else if (params.runtimeLookup.found) {
    source = "default";
  } else {
    source = "unset";
  }

  const authoredValue = authoredLookup.found ? authoredLookup.value : undefined;
  const runtimeValue = params.runtimeLookup.found ? params.runtimeLookup.value : undefined;
  const factCandidates = [
    params.snapshot.sourceConfig,
    params.snapshot.config,
    params.snapshot.authoredConfig,
  ];
  let secretRef: ConfigExplainSecretRef | undefined;
  for (const factOwner of factCandidates) {
    if (factOwner == null) {
      continue;
    }
    secretRef = resolveExplainSecretRef({
      path: factPath,
      factOwner,
      authoredValue,
      runtimeValue,
    });
    if (secretRef) {
      break;
    }
  }

  return {
    path: params.path,
    ...(params.runtimeLookup.found ? { runtimeValue: params.runtimeLookup.value } : {}),
    authoredPresent,
    source,
    ...(includeForResult ? { include: includeForResult } : {}),
    ...(secretRef ? { secretRef } : {}),
    ...(note ? { note } : {}),
  };
}

/** Human-readable explain output (no jq required). */
export function formatConfigExplainHuman(result: ConfigExplainResult): string {
  const lines = [
    `path: ${result.path}`,
    `source: ${result.source}`,
    `authoredPresent: ${result.authoredPresent}`,
  ];
  if ("runtimeValue" in result) {
    const value = result.runtimeValue;
    if (value === undefined) {
      lines.push("runtimeValue: undefined");
    } else if (
      typeof value === "string" ||
      typeof value === "number" ||
      typeof value === "boolean"
    ) {
      lines.push(`runtimeValue: ${String(value)}`);
    } else {
      lines.push(`runtimeValue: ${JSON.stringify(value)}`);
    }
  }
  if (result.include) {
    lines.push(`include.boundaryPath: ${result.include.boundaryPath}`);
    lines.push(`include.files: ${result.include.files.join(", ") || "(none)"}`);
    lines.push(`include.kind: ${result.include.kind}`);
    lines.push(`include.hasSiblingOverrides: ${result.include.hasSiblingOverrides}`);
    lines.push(`include.ambiguous: ${result.include.ambiguous}`);
  }
  if (result.secretRef) {
    lines.push(`secretRef.source: ${result.secretRef.source}`);
    lines.push(`secretRef.provider: ${result.secretRef.provider}`);
    lines.push(`secretRef.id: ${result.secretRef.id}`);
    lines.push(`secretRef.state: ${result.secretRef.state}`);
  }
  if (result.note) {
    lines.push(`note: ${result.note}`);
  }
  return `${lines.join("\n")}\n`;
}
