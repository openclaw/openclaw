const MIN_SECRET_VALUE_LENGTH = 6;
const MAX_SECRET_VALUES = 512;

const registeredValues = new Map<string, true>();
let compiledMatcher: RegExp | undefined;
let firstChars = new Set<string>();

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function rebuildProbe(): void {
  firstChars = new Set([...registeredValues.keys()].map((value) => value[0]));
  compiledMatcher = undefined;
}

function registerOneSecretValue(value: string): void {
  if (registeredValues.delete(value)) {
    registeredValues.set(value, true);
    return;
  }
  registeredValues.set(value, true);
  if (registeredValues.size > MAX_SECRET_VALUES) {
    const oldest = registeredValues.keys().next().value;
    if (oldest !== undefined) {
      registeredValues.delete(oldest);
    }
  }
  rebuildProbe();
}

/** Registers one resolved secret for exact-value log redaction. */
export function registerSecretValueForRedaction(value: string): void {
  if (value.length < MIN_SECRET_VALUE_LENGTH) {
    return;
  }
  registerOneSecretValue(value);
  // URL egress percent-encodes injected values; redact that surface form too.
  const encoded = encodeURIComponent(value);
  if (encoded !== value) {
    registerOneSecretValue(encoded);
  }
}

/** Returns whether a value has SecretRef provenance in the process registry. */
export function isSecretValueRegisteredForRedaction(value: string): boolean {
  return registeredValues.has(value);
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

/** Test-only reset for process-global redaction state. */
export function resetSecretRedactionRegistryForTest(): void {
  registeredValues.clear();
  rebuildProbe();
}
