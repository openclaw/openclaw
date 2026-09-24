import { pruneMapToMaxSize } from "../infra/map-size.js";
import { resolveGlobalSingleton } from "../shared/global-singleton.js";
import { escapeRegExp } from "../shared/regexp.js";

const MIN_SECRET_VALUE_LENGTH = 6;
const MAX_SECRET_VALUES = 512;

type SecretValueRedactor = (text: string, mask: (value: string, index: number) => string) => string;
type SecretRedactionRegistryState = {
  registeredValues: Map<string, true>;
  registryRevision: number;
  registeredValueRedactor: SecretValueRedactor | undefined;
};

// Native and source module copies share membership and matcher invalidation.
const state = resolveGlobalSingleton<SecretRedactionRegistryState>(
  Symbol.for("openclaw.secretRedactionRegistry"),
  () => ({
    registeredValues: new Map<string, true>(),
    registryRevision: 0,
    registeredValueRedactor: undefined,
  }),
);

function invalidateMatcher(): void {
  state.registryRevision += 1;
  state.registeredValueRedactor = undefined;
}

function registerOneSecretValue(value: string): void {
  if (state.registeredValues.delete(value)) {
    state.registeredValues.set(value, true);
    return;
  }
  state.registeredValues.set(value, true);
  pruneMapToMaxSize(state.registeredValues, MAX_SECRET_VALUES);
  invalidateMatcher();
}

/** Registers one resolved secret for exact-value log redaction. */
export function registerSecretValueForRedaction(value: string): void {
  if (value.length < MIN_SECRET_VALUE_LENGTH) {
    return;
  }
  // URL egress percent-encodes injected values; redact that surface form too.
  const encoded = encodeURIComponent(value);
  if (encoded !== value) {
    registerOneSecretValue(encoded);
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
  return state.registeredValues.has(value);
}

export function hasRegisteredSecretValuesForRedaction(): boolean {
  return state.registeredValues.size > 0;
}

/** Changes with registry membership, including bounded eviction and test resets. */
export function getSecretRedactionRegistryRevision(): number {
  return state.registryRevision;
}

/** Exact surface forms are already expanded; snapshots must not register them again. */
export function captureSecretRedactionRegistrySnapshot(): {
  revision: number;
  values: readonly string[];
} {
  return { revision: state.registryRevision, values: [...state.registeredValues.keys()] };
}

/** Replaces registered exact values while preserving the caller's mask convention. */
export function redactRegisteredSecretValues(
  text: string,
  mask: (value: string, index: number) => string,
): string {
  if (!text || state.registeredValues.size === 0) {
    return text;
  }
  state.registeredValueRedactor ??= createSecretValueRedactor([...state.registeredValues.keys()]);
  return state.registeredValueRedactor(text, mask);
}

export function createSecretValueRedactor(values: readonly string[]): SecretValueRedactor {
  let compiledMatcher: { prefixes: RegExp; buckets: Map<string, string[]> } | undefined;
  let firstChars: Set<string> | undefined;
  return (text, mask) => {
    if (!text || values.length === 0) {
      return text;
    }
    let couldMatch = false;
    // Registration can add several surface forms; prepare their probe once on first use.
    firstChars ??= new Set(values.map((value) => value.charAt(0)));
    for (const firstChar of firstChars) {
      if (text.includes(firstChar)) {
        couldMatch = true;
        break;
      }
    }
    if (!couldMatch) {
      return text;
    }
    if (!compiledMatcher) {
      const buckets = new Map<string, string[]>();
      for (const value of values.toSorted((left, right) => right.length - left.length)) {
        const prefix = value.slice(0, MIN_SECRET_VALUE_LENGTH);
        const bucket = buckets.get(prefix);
        if (bucket) {
          bucket.push(value);
        } else {
          buckets.set(prefix, [value]);
        }
      }
      // Supported store values can exceed the regex engine's literal span limit.
      // Compile fixed-width prefixes; verify complete values against the text.
      compiledMatcher = {
        prefixes: new RegExp([...buckets.keys()].map(escapeRegExp).join("|"), "g"),
        buckets,
      };
    }
    const { prefixes, buckets } = compiledMatcher;
    const matches: { index: number; value: string }[] = [];
    prefixes.lastIndex = 0;
    for (let match = prefixes.exec(text); match; match = prefixes.exec(text)) {
      const index = match.index;
      const value = buckets.get(match[0])?.find((candidate) => text.startsWith(candidate, index));
      if (value !== undefined) {
        matches.push({ index, value });
      }
      // A rejected prefix may overlap a real match beginning one code unit later.
      prefixes.lastIndex = index + (value?.length ?? 1);
    }
    // Global replacement fixes its matches before callbacks. Nested registration
    // must affect the next/nested call, never the remainder of this one.
    let result = "";
    let cursor = 0;
    for (const match of matches) {
      result += `${text.slice(cursor, match.index)}${mask(match.value, match.index)}`;
      cursor = match.index + match.value.length;
    }
    return result + text.slice(cursor);
  };
}

function resetSecretRedactionRegistryForTest(): void {
  state.registeredValues.clear();
  invalidateMatcher();
}

if (process.env.VITEST || process.env.NODE_ENV === "test") {
  (globalThis as Record<PropertyKey, unknown>)[
    Symbol.for("openclaw.secretRedactionRegistryTestApi")
  ] = { resetSecretRedactionRegistryForTest };
}
