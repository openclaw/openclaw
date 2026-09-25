import { isSensitiveConfigPath } from "../../../src/config/sensitive-paths.js";
import type { ConfigUiHints } from "../api/types.ts";
import { t } from "../i18n/index.ts";
import { hintForPath, isSensitiveLeafValue, pathKey } from "../lib/config-form-utils.ts";

export {
  hintForPath,
  humanize,
  localizedHintForPath,
  pathKey,
  schemaMayAcceptString,
  schemaType,
  type JsonSchema,
} from "../lib/config-form-utils.ts";

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

export function hasSensitiveConfigData(
  value: unknown,
  path: Array<string | number>,
  hints: ConfigUiHints,
): boolean {
  return countSensitiveConfigValuesInner(value, path, hints, { visited: 0 }, 0, 1) > 0;
}

export function countSensitiveConfigValues(
  value: unknown,
  path: Array<string | number>,
  hints: ConfigUiHints,
): number {
  return countSensitiveConfigValuesInner(value, path, hints, { visited: 0 }, 0, Infinity);
}

function countSensitiveConfigValuesInner(
  value: unknown,
  path: Array<string | number>,
  hints: ConfigUiHints,
  scan: SensitiveScanState,
  depth: number,
  limit: number,
): number {
  if (!enterSensitiveScanNode(scan, depth)) {
    return 1;
  }

  if (value == null) {
    return 0;
  }

  const key = pathKey(path);
  const hint = hintForPath(path, hints);
  const pathIsSensitive = hint?.sensitive || isSensitiveConfigPath(key);

  if (pathIsSensitive && isSensitiveLeafValue(value)) {
    return 1;
  }

  let count = 0;
  const visit = (childValue: unknown, childKey: string | number): boolean => {
    count += countSensitiveConfigValuesInner(
      childValue,
      [...path, childKey],
      hints,
      scan,
      depth + 1,
      limit - count,
    );
    return count >= limit;
  };
  if (Array.isArray(value)) {
    value.some(visit);
  } else if (value && typeof value === "object") {
    Object.entries(value).some(([childKey, childValue]) => visit(childValue, childKey));
  }
  return count;
}
