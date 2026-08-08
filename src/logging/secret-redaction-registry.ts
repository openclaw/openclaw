import { pruneMapToMaxSize } from "../infra/map-size.js";
import { escapeRegExp } from "../shared/regexp.js";

const MIN_SECRET_VALUE_LENGTH = 6;
const MAX_SECRET_VALUES = 512;
const MIN_TRUNCATED_SENSITIVE_PREFIX_LENGTH = 6;

const registeredValues = new Map<string, true>();
let compiledMatcher: RegExp | undefined;
let firstChars = new Set<string>();

function rebuildProbe(): void {
  firstChars = new Set([...registeredValues.keys()].map((value) => value.charAt(0)));
  compiledMatcher = undefined;
}

function registerOneSecretValue(value: string): void {
  if (registeredValues.delete(value)) {
    registeredValues.set(value, true);
    return;
  }
  registeredValues.set(value, true);
  pruneMapToMaxSize(registeredValues, MAX_SECRET_VALUES);
  rebuildProbe();
}

type SuppliedSecretReplacement = {
  candidate: string;
  replacement: string;
  percentEscapesCaseInsensitive: boolean;
};

function encodeFormComponentFromUriComponent(uriEncoded: string): string {
  return uriEncoded
    .replace(/%20/gu, "+")
    .replace(
      /[!'()~]/gu,
      (character) => `%${character.charCodeAt(0).toString(16).toUpperCase().padStart(2, "0")}`,
    );
}

function collectSuppliedSecretReplacements(
  values: readonly string[] | undefined,
  mask: (value: string) => string,
): SuppliedSecretReplacement[] {
  const replacements = new Map<string, SuppliedSecretReplacement>();
  const addCandidate = (params: {
    candidate: string;
    replacement: string;
    percentEscapesCaseInsensitive?: boolean;
  }) => {
    if (!params.candidate) {
      return;
    }
    const existing = replacements.get(params.candidate);
    replacements.set(params.candidate, {
      candidate: params.candidate,
      replacement: params.replacement,
      percentEscapesCaseInsensitive:
        existing?.percentEscapesCaseInsensitive === true ||
        params.percentEscapesCaseInsensitive === true,
    });
  };
  const addRepresentation = (params: {
    candidate: string;
    replacement: string;
    percentEscapesCaseInsensitive?: boolean;
  }) => {
    addCandidate(params);
    // A provider can reflect an already-encoded value inside a JSON error
    // string, adding one more escaping layer around quotes and backslashes.
    addCandidate({
      ...params,
      candidate: JSON.stringify(params.candidate).slice(1, -1),
    });
  };

  for (const value of values ?? []) {
    if (!value) {
      continue;
    }
    const replacement = mask(value);
    addRepresentation({ candidate: value, replacement });
    addRepresentation({
      candidate: JSON.stringify(value).slice(1, -1),
      replacement,
    });
    try {
      const urlEncoded = encodeURIComponent(value);
      addRepresentation({
        candidate: urlEncoded,
        replacement,
        percentEscapesCaseInsensitive: true,
      });
      addRepresentation({
        candidate: encodeFormComponentFromUriComponent(urlEncoded),
        replacement,
        percentEscapesCaseInsensitive: true,
      });
    } catch {
      // Lone UTF-16 surrogates cannot be URL encoded; raw and JSON forms still apply.
    }
  }

  return [...replacements.values()];
}

function buildPercentEscapeCaseInsensitivePattern(candidate: string): RegExp {
  const source = escapeRegExp(candidate).replace(
    /%([0-9A-Fa-f])([0-9A-Fa-f])/gu,
    (_match, first: string, second: string) => {
      const hexPattern = (character: string) => {
        const upper = character.toUpperCase();
        return /[A-F]/u.test(upper) ? `[${upper}${upper.toLowerCase()}]` : upper;
      };
      return `%${hexPattern(first)}${hexPattern(second)}`;
    },
  );
  return new RegExp(source, "gu");
}

function normalizePercentEscapeHexCase(value: string): string {
  return value.replace(/%([0-9A-Fa-f]{1,2})/gu, (_escape, hex: string) => `%${hex.toUpperCase()}`);
}

function redactTruncatedSuppliedSecretSuffix(
  text: string,
  replacements: readonly SuppliedSecretReplacement[],
): string {
  let longestPartialSuffix = 0;
  for (const replacement of replacements) {
    if (replacement.candidate.length < 2) {
      continue;
    }
    const comparableText = replacement.percentEscapesCaseInsensitive
      ? normalizePercentEscapeHexCase(text)
      : text;
    const comparableCandidate = replacement.percentEscapesCaseInsensitive
      ? normalizePercentEscapeHexCase(replacement.candidate)
      : replacement.candidate;
    // Complete values are already redacted. Require a meaningful prefix so an
    // ordinary one-character suffix does not suppress an otherwise safe diagnostic.
    if (comparableText.endsWith(comparableCandidate)) {
      continue;
    }
    const minimumPrefixLength = Math.min(
      MIN_TRUNCATED_SENSITIVE_PREFIX_LENGTH,
      comparableCandidate.length - 1,
    );
    const maxPrefixLength = Math.min(comparableCandidate.length - 1, comparableText.length);
    for (
      let prefixLength = maxPrefixLength;
      prefixLength >= minimumPrefixLength && prefixLength > longestPartialSuffix;
      prefixLength -= 1
    ) {
      if (comparableText.endsWith(comparableCandidate.slice(0, prefixLength))) {
        longestPartialSuffix = prefixLength;
        break;
      }
    }
  }
  if (longestPartialSuffix === 0) {
    return text;
  }
  return `${text.slice(0, -longestPartialSuffix)}[truncated diagnostic omitted because it ended with a partial sensitive value]`;
}

/** Redacts exact caller-supplied secrets without retaining them in process state. */
export function redactSuppliedSecretValues(
  text: string,
  values: readonly string[] | undefined,
  mask: (value: string) => string,
  options?: { sourceTruncated?: boolean },
): string {
  if (!text || !values?.length) {
    return text;
  }
  const replacements = collectSuppliedSecretReplacements(values, mask).toSorted(
    (left, right) => right.candidate.length - left.candidate.length,
  );
  let redacted = text;
  for (const replacement of replacements) {
    redacted = replacement.percentEscapesCaseInsensitive
      ? redacted.replace(
          buildPercentEscapeCaseInsensitivePattern(replacement.candidate),
          () => replacement.replacement,
        )
      : redacted.replaceAll(replacement.candidate, () => replacement.replacement);
  }
  return options?.sourceTruncated
    ? redactTruncatedSuppliedSecretSuffix(redacted, replacements)
    : redacted;
}

/** Registers one resolved secret for exact-value log redaction. */
export function registerSecretValueForRedaction(value: string): void {
  if (value.length < MIN_SECRET_VALUE_LENGTH) {
    return;
  }
  // URL egress percent-encodes injected values; redact that surface form too.
  try {
    const encoded = encodeURIComponent(value);
    if (encoded !== value) {
      registerOneSecretValue(encoded);
    }
  } catch {
    // Lone UTF-16 surrogates still retain raw and JSON exact-value coverage.
  }
  // Captured structured payloads are serialized before persistence, so retain
  // the JSON string-content form for credentials with escaped characters.
  const jsonEscaped = JSON.stringify(value).slice(1, -1);
  if (jsonEscaped !== value) {
    registerOneSecretValue(jsonEscaped);
  }
  // Keep the raw value newest so bounded-registry eviction cannot drop the
  // active credential while retaining only a transformed representation.
  registerOneSecretValue(value);
}

/** Returns whether a value has SecretRef provenance in the process registry. */
export function isSecretValueRegisteredForRedaction(value: string): boolean {
  return registeredValues.has(value);
}

export function hasRegisteredSecretValuesForRedaction(): boolean {
  return registeredValues.size > 0;
}

/** Replaces registered exact values while preserving the caller's mask convention. */
export function redactRegisteredSecretValues(
  text: string,
  mask: (value: string) => string,
): string {
  if (!text || registeredValues.size === 0) {
    return text;
  }
  let couldMatch = false;
  for (const firstChar of firstChars) {
    if (text.includes(firstChar)) {
      couldMatch = true;
      break;
    }
  }
  if (!couldMatch) {
    return text;
  }
  compiledMatcher ??= new RegExp(
    [...registeredValues.keys()]
      .toSorted((left, right) => right.length - left.length)
      .map(escapeRegExp)
      .join("|"),
    "g",
  );
  return text.replace(compiledMatcher, (value) => mask(value));
}

function resetSecretRedactionRegistryForTest(): void {
  registeredValues.clear();
  rebuildProbe();
}

if (process.env.VITEST || process.env.NODE_ENV === "test") {
  (globalThis as Record<PropertyKey, unknown>)[
    Symbol.for("openclaw.secretRedactionRegistryTestApi")
  ] = { resetSecretRedactionRegistryForTest };
}
