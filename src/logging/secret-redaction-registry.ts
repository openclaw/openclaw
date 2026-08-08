import { pruneMapToMaxSize } from "../infra/map-size.js";
import { escapeRegExp } from "../shared/regexp.js";

const MIN_SECRET_VALUE_LENGTH = 6;
const MAX_SECRET_VALUES = 512;

type SecretValueVariant = {
  value: string;
  percentEscapesCaseInsensitive: boolean;
};

const registeredValues = new Map<string, boolean>();
let compiledMatcher: RegExp | undefined;
let firstChars = new Set<string>();

function rebuildProbe(): void {
  firstChars = new Set([...registeredValues.keys()].map((value) => value.charAt(0)));
  compiledMatcher = undefined;
}

function registerOneSecretValue(variant: SecretValueVariant): void {
  const previousPercentMode = registeredValues.get(variant.value);
  const percentEscapesCaseInsensitive =
    previousPercentMode === true || variant.percentEscapesCaseInsensitive;
  if (registeredValues.delete(variant.value)) {
    registeredValues.set(variant.value, percentEscapesCaseInsensitive);
    if (previousPercentMode !== percentEscapesCaseInsensitive) {
      rebuildProbe();
    }
    return;
  }
  registeredValues.set(variant.value, percentEscapesCaseInsensitive);
  pruneMapToMaxSize(registeredValues, MAX_SECRET_VALUES);
  rebuildProbe();
}

function secretValueVariants(value: string): SecretValueVariant[] {
  const variants: SecretValueVariant[] = [];
  // Provider egress can percent-encode a configured value before a remote
  // endpoint reflects it, so keep that wire form tied to the same secret.
  const encoded = encodeURIComponent(value);
  if (encoded !== value) {
    variants.push({ value: encoded, percentEscapesCaseInsensitive: true });
  }
  // Structured error bodies escape quotes and control characters before the
  // redactor receives response text; match that serialized content too.
  const jsonEscaped = JSON.stringify(value).slice(1, -1);
  if (jsonEscaped !== value) {
    variants.push({ value: jsonEscaped, percentEscapesCaseInsensitive: false });
  }
  variants.push({ value, percentEscapesCaseInsensitive: false });
  return variants;
}

function secretValuePattern(variant: SecretValueVariant): string {
  const escaped = escapeRegExp(variant.value);
  if (!variant.percentEscapesCaseInsensitive) {
    return escaped;
  }
  return escaped.replace(
    /%([0-9A-Fa-f])([0-9A-Fa-f])/gu,
    (_match, first: string, second: string) => {
      const hexPattern = (character: string) => {
        const upper = character.toUpperCase();
        return /[A-F]/u.test(upper) ? `[${upper}${upper.toLowerCase()}]` : upper;
      };
      return `%${hexPattern(first)}${hexPattern(second)}`;
    },
  );
}

function normalizePercentEscapeCase(value: string): string {
  return value.replace(/%[0-9A-Fa-f]{2}/gu, (escape) => escape.toUpperCase());
}

function redactTruncatedSecretSuffix(text: string, variants: Iterable<SecretValueVariant>): string {
  let longestPartialSuffix = 0;
  for (const variant of variants) {
    const comparableText = variant.percentEscapesCaseInsensitive
      ? normalizePercentEscapeCase(text)
      : text;
    const comparableValue = variant.percentEscapesCaseInsensitive
      ? normalizePercentEscapeCase(variant.value)
      : variant.value;
    if (comparableText.endsWith(comparableValue)) {
      continue;
    }
    const maxLength = Math.min(comparableText.length, comparableValue.length - 1);
    for (let length = maxLength; length > longestPartialSuffix; length -= 1) {
      if (comparableText.endsWith(comparableValue.slice(0, length))) {
        longestPartialSuffix = length;
        break;
      }
    }
  }
  return longestPartialSuffix > 0 ? `${text.slice(0, -longestPartialSuffix)}***` : text;
}

/** Registers one resolved secret for exact-value log redaction. */
export function registerSecretValueForRedaction(value: string): void {
  if (value.length < MIN_SECRET_VALUE_LENGTH) {
    return;
  }
  // The raw value stays newest so bounded-registry eviction cannot drop the
  // active credential while retaining only a transformed representation.
  for (const variant of secretValueVariants(value)) {
    registerOneSecretValue(variant);
  }
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
  const variants = new Map<string, SecretValueVariant>();
  const addVariant = (variant: SecretValueVariant) => {
    const previous = variants.get(variant.value);
    variants.set(variant.value, {
      value: variant.value,
      percentEscapesCaseInsensitive:
        previous?.percentEscapesCaseInsensitive === true || variant.percentEscapesCaseInsensitive,
    });
  };
  for (const value of values) {
    if (!value) {
      continue;
    }
    for (const variant of secretValueVariants(value)) {
      addVariant(variant);
    }
    // Form serialization is request-scoped so its extra representation cannot
    // consume capacity in the bounded process-wide secret registry.
    addVariant({
      value: new URLSearchParams([["value", value]]).toString().slice("value=".length),
      percentEscapesCaseInsensitive: true,
    });
  }
  if (variants.size === 0) {
    return text;
  }
  const matcher = new RegExp(
    [...variants.values()]
      .toSorted((left, right) => right.value.length - left.value.length)
      .map(secretValuePattern)
      .join("|"),
    "g",
  );
  const redacted = text.replace(matcher, (value) => mask(value));
  return options?.sourceTruncated
    ? redactTruncatedSecretSuffix(redacted, variants.values())
    : redacted;
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
    [...registeredValues.entries()]
      .map(([value, percentEscapesCaseInsensitive]) => ({
        value,
        percentEscapesCaseInsensitive,
      }))
      .toSorted((left, right) => right.value.length - left.value.length)
      .map(secretValuePattern)
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
