import { isSensitiveConfigPath } from "../../../src/config/sensitive-paths.js";
import type { ConfigUiHint, ConfigUiHints } from "../api/types.ts";
import { t } from "../i18n/index.ts";
import { configHintTranslationKey } from "../i18n/lib/config-hint-translation.ts";
import { translateActive } from "../i18n/lib/translate.ts";
import { isSensitiveLeafValue } from "../lib/config-form-utils.ts";

export { schemaMayAcceptString, schemaType, type JsonSchema } from "../lib/config-form-utils.ts";

export function pathKey(path: Array<string | number>): string {
  return path.filter((segment) => typeof segment === "string").join(".");
}

const wildcardHintCache = new WeakMap<ConfigUiHints, Array<[string[], ConfigUiHint]>>();

type ResolvedConfigUiHint = {
  hint: ConfigUiHint;
  hintPath: string;
};

function resolveHintForPath(
  path: Array<string | number>,
  hints: ConfigUiHints,
): ResolvedConfigUiHint | undefined {
  const directPath = pathKey(path);
  const direct = hints[directPath];
  if (direct) {
    return { hint: direct, hintPath: directPath };
  }
  const segments = path.map(String);
  let wildcardHints = wildcardHintCache.get(hints);
  if (!wildcardHints) {
    wildcardHints = Object.entries(hints).flatMap(([hintKey, hint]) =>
      hintKey.includes("*") ? [[hintKey.split("."), hint]] : [],
    );
    wildcardHintCache.set(hints, wildcardHints);
  }
  for (const [hintSegments, hint] of wildcardHints) {
    if (
      hintSegments.length === segments.length &&
      hintSegments.every((segment, index) => segment === "*" || segment === segments[index])
    ) {
      return { hint, hintPath: hintSegments.join(".") };
    }
  }
  return undefined;
}

export function hintForPath(path: Array<string | number>, hints: ConfigUiHints) {
  return resolveHintForPath(path, hints)?.hint;
}

export function localizedHintForPath(path: Array<string | number>, hints: ConfigUiHints) {
  const resolved = resolveHintForPath(path, hints);
  if (!resolved) {
    return undefined;
  }
  const { hint, hintPath } = resolved;
  return {
    ...hint,
    label: hint.label
      ? (translateActive(configHintTranslationKey(hintPath, "label", hint.label)) ?? hint.label)
      : hint.label,
    help: hint.help
      ? (translateActive(configHintTranslationKey(hintPath, "help", hint.help)) ?? hint.help)
      : hint.help,
  };
}

export function humanize(raw: string) {
  return raw
    .replace(/_/g, " ")
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/\s+/g, " ")
    .replace(/^./, (m) => m.toUpperCase());
}

export function configFieldId(path: Array<string | number>, suffix: string): string {
  const key =
    path.length === 0
      ? "root"
      : path
          .map((segment) => {
            const value = String(segment);
            let encoded = "";
            for (let index = 0; index < value.length; index += 1) {
              encoded += value.charCodeAt(index).toString(16).padStart(4, "0");
            }
            const type = typeof segment === "number" ? "n" : "s";
            return `${type}${value.length}-${encoded}`;
          })
          .join("_");
  return `config-field-${key}-${suffix}`;
}

export function redactedPlaceholder(): string {
  return t("configForm.redactedPlaceholder");
}

const MAX_SENSITIVE_SCAN_DEPTH = 64;
const MAX_SENSITIVE_SCAN_NODES = 20_000;

type SensitiveScanState = {
  visited: number;
};

function createSensitiveScanState(): SensitiveScanState {
  return { visited: 0 };
}

function enterSensitiveScanNode(state: SensitiveScanState, depth: number): boolean {
  if (depth > MAX_SENSITIVE_SCAN_DEPTH) {
    return false;
  }
  state.visited += 1;
  if (state.visited > MAX_SENSITIVE_SCAN_NODES) {
    return false;
  }
  return true;
}

function isHintSensitive(hint: ConfigUiHint | undefined): boolean {
  return hint?.sensitive ?? false;
}

export function hasSensitiveConfigData(
  value: unknown,
  path: Array<string | number>,
  hints: ConfigUiHints,
): boolean {
  return hasSensitiveConfigDataInner(value, path, hints, createSensitiveScanState(), 0);
}

function hasSensitiveConfigDataInner(
  value: unknown,
  path: Array<string | number>,
  hints: ConfigUiHints,
  scan: SensitiveScanState,
  depth: number,
): boolean {
  if (!enterSensitiveScanNode(scan, depth)) {
    return true;
  }

  const key = pathKey(path);
  const hint = hintForPath(path, hints);
  const pathIsSensitive = isHintSensitive(hint) || isSensitiveConfigPath(key);

  if (pathIsSensitive && isSensitiveLeafValue(value)) {
    return true;
  }

  if (Array.isArray(value)) {
    return value.some((item, index) =>
      hasSensitiveConfigDataInner(item, [...path, index], hints, scan, depth + 1),
    );
  }

  if (value && typeof value === "object") {
    return Object.entries(value as Record<string, unknown>).some(([childKey, childValue]) =>
      hasSensitiveConfigDataInner(childValue, [...path, childKey], hints, scan, depth + 1),
    );
  }

  return false;
}

export function countSensitiveConfigValues(
  value: unknown,
  path: Array<string | number>,
  hints: ConfigUiHints,
): number {
  return countSensitiveConfigValuesInner(value, path, hints, createSensitiveScanState(), 0);
}

function countSensitiveConfigValuesInner(
  value: unknown,
  path: Array<string | number>,
  hints: ConfigUiHints,
  scan: SensitiveScanState,
  depth: number,
): number {
  if (!enterSensitiveScanNode(scan, depth)) {
    return 1;
  }

  if (value == null) {
    return 0;
  }

  const key = pathKey(path);
  const hint = hintForPath(path, hints);
  const pathIsSensitive = isHintSensitive(hint) || isSensitiveConfigPath(key);

  if (pathIsSensitive && isSensitiveLeafValue(value)) {
    return 1;
  }

  if (Array.isArray(value)) {
    return value.reduce(
      (count, item, index) =>
        count + countSensitiveConfigValuesInner(item, [...path, index], hints, scan, depth + 1),
      0,
    );
  }

  if (value && typeof value === "object") {
    return Object.entries(value as Record<string, unknown>).reduce(
      (count, [childKey, childValue]) =>
        count +
        countSensitiveConfigValuesInner(childValue, [...path, childKey], hints, scan, depth + 1),
      0,
    );
  }

  return 0;
}
