import { isRecord } from "@openclaw/normalization-core/record-coerce";
import type { Accessor } from "@solidjs/signals";
import type { JSX } from "@solidjs/web";
import type { nothing, TemplateResult } from "lit";
import { isSensitiveConfigPath } from "../../../src/config/sensitive-paths.js";
import type { ConfigUiHints } from "../api/types.ts";
import { t } from "../i18n/index.ts";
import { isEnvPlaceholder, REDACTED_SENTINEL } from "../lib/config-form-utils.ts";
import { formatUnknownText } from "../lib/format.ts";
import { formatConfigFormNumber } from "./config-form.numeric.ts";
import { resolveConfigFieldMeta, type ConfigSearchCriteria } from "./config-form.search.ts";
import {
  configFieldId,
  hasSensitiveConfigData,
  hintForPath,
  pathKey as configPathKey,
  type JsonSchema,
} from "./config-form.shared.ts";

const META_KEYS = new Set([
  "title",
  "description",
  "default",
  "nullable",
  "enumIncludesNull",
  "tags",
  "x-tags",
]);

export type ConfigNodeRenderParams = {
  schema: JsonSchema;
  value: unknown;
  path: Array<string | number>;
  hints: ConfigUiHints;
  rawAvailable?: boolean;
  unsupported: Set<string>;
  disabled: boolean;
  isRequired?: boolean;
  sourceIdentity?: unknown;
  controlIdentity?: unknown;
  structuredDraftOwner?: boolean;
  showLabel?: boolean;
  /** Description rendered by the surrounding field layout. */
  descriptionId?: string;
  /** Compact editors show effective defaults and inline collection controls. */
  compact?: boolean;
  commitOnBlur?: boolean;
  /** Section shells own the title while collection rows still own help/default metadata. */
  showHeaderMeta?: boolean;
  searchCriteria?: ConfigSearchCriteria;
  revealSensitive?: boolean;
  maskSensitive?: boolean;
  isSensitivePathRevealed?: (path: Array<string | number>) => boolean;
  onToggleSensitivePath?: (path: Array<string | number>) => void;
  onPatch: (path: Array<string | number>, value: unknown) => boolean | void;
  onRemove?: (path: Array<string | number>) => boolean | void;
};

export type ConfigNodeRenderer = (params: Accessor<ConfigNodeRenderParams>) => JSX.Element;
export type LegacyNodeRenderer = (
  params: ConfigNodeRenderParams,
) => TemplateResult | typeof nothing;

export function configChildRenderOptions(params: ConfigNodeRenderParams) {
  return {
    hints: params.hints,
    rawAvailable: params.rawAvailable,
    maskSensitive: params.maskSensitive,
    unsupported: params.unsupported,
    disabled: params.disabled,
    compact: params.compact,
    commitOnBlur: params.commitOnBlur,
    revealSensitive: params.revealSensitive,
    isSensitivePathRevealed: params.isSensitivePathRevealed,
    onToggleSensitivePath: params.onToggleSensitivePath,
  };
}

export function resolveConfigFieldPresentation(params: ConfigNodeRenderParams) {
  const { label, help } = resolveConfigFieldMeta(params.path, params.schema, params.hints);
  const showLabel = params.showLabel ?? true;
  return {
    label,
    help,
    showLabel,
    helpId:
      params.descriptionId ??
      (showLabel && help ? configFieldId(params.path, "description") : undefined),
  };
}

export type SensitiveRenderState = {
  isSensitive: boolean;
  /** The path or hint marks the field sensitive, whether or not it holds a value yet. */
  isSensitiveField: boolean;
  isMasked: boolean;
  isRedacted: boolean;
  isRevealed: boolean;
  canReveal: boolean;
  sentinelRedacted: boolean;
};

export function isAnySchema(schema: JsonSchema): boolean {
  return Object.keys(schema).every((key) => META_KEYS.has(key));
}

export function jsonValue(value: unknown): string {
  if (value === undefined) {
    return "";
  }
  try {
    return JSON.stringify(value, null, 2) ?? "";
  } catch {
    return "";
  }
}

export function formatConfigValueText(value: unknown): string {
  return typeof value === "number" ? formatConfigFormNumber(value) : formatUnknownText(value);
}

export function isSecretRefObject(value: unknown): value is {
  source: string;
  id: string;
  provider?: string;
} {
  if (!isRecord(value)) {
    return false;
  }
  if (typeof value.source !== "string" || typeof value.id !== "string") {
    return false;
  }
  return value.provider === undefined || typeof value.provider === "string";
}

export function getSensitiveRenderState(params: {
  path: Array<string | number>;
  value: unknown;
  hints: ConfigUiHints;
  revealSensitive?: boolean;
  maskSensitive?: boolean;
  isSensitivePathRevealed?: (path: Array<string | number>) => boolean;
}): SensitiveRenderState {
  const isSensitive = hasSensitiveConfigData(params.value, params.path, params.hints);
  // The server never sends plaintext secrets: a stored secret arrives as the
  // redaction sentinel. Revealing it would display the sentinel as an editable
  // value; any edit then overwrites the real credential with mangled text.
  const sentinel = params.value === REDACTED_SENTINEL;
  const isRevealed =
    isSensitive &&
    !sentinel &&
    (params.revealSensitive || (params.isSensitivePathRevealed?.(params.path) ?? false));
  const isSensitiveField =
    hintForPath(params.path, params.hints)?.sensitive ||
    isSensitiveConfigPath(configPathKey(params.path));
  return {
    isSensitive,
    isSensitiveField,
    isMasked:
      params.maskSensitive === true &&
      !params.revealSensitive &&
      !isRevealed &&
      (params.value === undefined || typeof params.value === "string") &&
      // An env placeholder such as ${TOKEN} names a variable; it is not a secret to hide.
      !(typeof params.value === "string" && isEnvPlaceholder(params.value)) &&
      (isSensitiveField || isSensitive),
    isRedacted: isSensitive && !isRevealed,
    isRevealed,
    canReveal: isSensitive && !sentinel,
    sentinelRedacted: sentinel,
  };
}

export function configEnumOptionLabel(option: unknown, options: readonly unknown[]): string {
  const presentsBooleanState = options.includes(true) && options.includes(false);
  if (!presentsBooleanState) {
    return formatConfigValueText(option);
  }
  if (option === true) {
    return t("configForm.enumOn");
  }
  if (option === false) {
    return t("configForm.enumOff");
  }
  return option === "auto" ? t("configForm.enumAuto") : formatConfigValueText(option);
}
