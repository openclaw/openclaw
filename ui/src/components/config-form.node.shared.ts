import { isRecord } from "@openclaw/normalization-core/record-coerce";
import type { Accessor } from "@solidjs/signals";
import type { JSX } from "@solidjs/web";
import { isSensitiveConfigPath } from "../../../src/config/sensitive-paths.js";
import type { ConfigUiHints } from "../api/types.ts";
import { t } from "../i18n/index.ts";
import { isEnvPlaceholder, REDACTED_SENTINEL } from "../lib/config-form-utils.ts";
import type {
  ConfigSecretFields,
  StoredSecretSources,
} from "../lib/config/config-secret-fields.ts";
import { formatUnknownText } from "../lib/format.ts";
import { isSupportedConfigValueValid } from "./config-form.constraints.ts";
import { configLabelInContext } from "./config-form.label-context.ts";
import { humanizeConfigEnumValue } from "./config-form.labels.ts";
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
  /** The nearest visible heading, whose name a row's label need not repeat. */
  contextLabel?: string;
  /** Help of an enclosing object that renders no row of its own. */
  helpContext?: readonly string[];
  /** The surrounding section heading names this object, and its "?" carries lifted help. */
  sectionRoot?: boolean;
  /** The long form of a string-or-object setting: with no fields left, the setting is unset. */
  shorthandObject?: boolean;
  /** This object renders its fields in place: a lone setting, or the only group at its level. */
  inlineObject?: "lone-setting" | "only-group";
  /** Section shells own the title while collection rows still own help/default metadata. */
  showHeaderMeta?: boolean;
  /** Keep every nested group of settings closed until it is opened. */
  collapseObjects?: boolean;
  /** Yield initial collection rows with the form's first-visit presentation. */
  progressive?: boolean;
  /** State worth reading without opening a nested group, shown on its summary row. */
  summarizeObject?: (path: Array<string | number>, value: unknown) => JSX.Element;
  searchCriteria?: ConfigSearchCriteria;
  revealSensitive?: boolean;
  maskSensitive?: boolean;
  isSensitivePathRevealed?: (path: Array<string | number>) => boolean;
  onToggleSensitivePath?: (path: Array<string | number>) => void;
  /** Switches this page to its Raw tab; absent where the page has none. */
  onOpenRaw?: () => void;
  /** Secret-marked fields hold their edit here and write through their own Save. */
  secretFields?: ConfigSecretFields;
  /** The form's own Save writes these edits, so a stored secret can be typed over. */
  replaceStoredSecrets?: StoredSecretSources;
  onPatch: (path: Array<string | number>, value: unknown) => boolean | void;
  onRemove?: (path: Array<string | number>) => boolean | void;
};

export type ConfigNodeRenderer = (params: Accessor<ConfigNodeRenderParams>) => JSX.Element;

export function configChildRenderOptions(params: ConfigNodeRenderParams) {
  return {
    hints: params.hints,
    rawAvailable: params.rawAvailable,
    maskSensitive: params.maskSensitive,
    unsupported: params.unsupported,
    disabled: params.disabled,
    compact: params.compact,
    commitOnBlur: params.commitOnBlur,
    collapseObjects: params.collapseObjects,
    progressive: params.progressive,
    summarizeObject: params.summarizeObject,
    revealSensitive: params.revealSensitive,
    isSensitivePathRevealed: params.isSensitivePathRevealed,
    onToggleSensitivePath: params.onToggleSensitivePath,
    onOpenRaw: params.onOpenRaw,
    secretFields: params.secretFields,
    replaceStoredSecrets: params.replaceStoredSecrets,
  };
}

export function resolveConfigFieldPresentation(params: ConfigNodeRenderParams) {
  const { label, help } = resolveConfigFieldMeta(params.path, params.schema, params.hints);
  const showLabel = params.showLabel ?? true;
  return {
    label,
    title: configLabelInContext(label, params.contextLabel),
    help,
    showLabel,
    placement: params.compact ? undefined : ("column" as const),
    path: params.path,
    helpContext: params.helpContext,
    required: configFieldRequiresInput(params),
    helpId:
      params.descriptionId ??
      (showLabel && help ? configFieldId(params.path, "description") : undefined),
  };
}

export function configFieldRequiresInput(
  params: Pick<ConfigNodeRenderParams, "schema" | "isRequired">,
): boolean {
  return (
    params.isRequired === true &&
    (params.schema.default === undefined ||
      !isSupportedConfigValueValid(params.schema, params.schema.default))
  );
}

export type SensitiveRenderState = ReturnType<typeof getSensitiveRenderState>;

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
}) {
  const isSensitive = hasSensitiveConfigData(params.value, params.path, params.hints);
  // The server never sends plaintext secrets: a stored secret arrives as the
  // redaction sentinel. Revealing it would display the sentinel as an editable
  // value; any edit then overwrites the real credential with mangled text.
  const sentinel = params.value === REDACTED_SENTINEL;
  const isRevealed =
    isSensitive &&
    !sentinel &&
    (params.revealSensitive || (params.isSensitivePathRevealed?.(params.path) ?? false));
  // The path or hint is sensitive even when it does not hold a value yet.
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
  if (presentsBooleanState && option === true) {
    return t("configForm.enumOn");
  }
  if (presentsBooleanState && option === false) {
    return t("configForm.enumOff");
  }
  if (presentsBooleanState && option === "auto") {
    return t("configForm.enumAuto");
  }
  return typeof option === "string"
    ? humanizeConfigEnumValue(option)
    : formatConfigValueText(option);
}
