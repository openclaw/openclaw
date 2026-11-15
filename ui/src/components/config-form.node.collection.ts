import { asNonArrayRecord, isRecord } from "@openclaw/normalization-core/record-coerce";
import { copyWithPathPatch, objectFormOfUnion, schemaType } from "../lib/config-form-utils.ts";
import {
  objectAdditionalPropertiesSchema,
  objectPropertyKeys,
  objectPropertySchema,
  requiredPropertyKeys,
} from "./config-form.array-items.ts";
import { canApplyObjectCandidate, isObjectPropertyNameValid } from "./config-form.constraints.ts";
import { configChildRenderOptions, isSecretRefObject } from "./config-form.node.shared.ts";
import type { ConfigNodeRenderParams } from "./config-form.node.shared.ts";
import {
  hasConfigSearchCriteria as hasSearchCriteria,
  matchesNodeSelf,
  resolveConfigFieldMeta,
} from "./config-form.search.ts";
import { hintForPath, type JsonSchema } from "./config-form.shared.ts";

const UNSET_MAP_SOURCE_IDENTITY = Symbol("unset-map-source");

type ConfigFieldShape = "scalar" | "collection" | "object";

// Rows read top to bottom: settings first, then what they can add, then what opens further.
const SHAPE_ORDER: Record<ConfigFieldShape, number> = { scalar: 0, collection: 1, object: 2 };

// Groups naming a model read together, the main one first, whatever their keys sort to.
function modelGroupRank(key: string): number {
  if (key === "model") {
    return 0;
  }
  if (key.endsWith("Model")) {
    return 1;
  }
  if (key.endsWith("Models")) {
    return 2;
  }
  return /model/i.test(key) ? 3 : 4;
}

function unwrapNullable(schema: JsonSchema): JsonSchema {
  const variants = (schema.anyOf ?? schema.oneOf ?? []).filter(
    (variant) =>
      !(variant.type === "null" || (Array.isArray(variant.type) && variant.type.includes("null"))),
  );
  return variants.length === 1 && variants[0] ? unwrapNullable(variants[0]) : schema;
}

function configFieldShape(input: JsonSchema): ConfigFieldShape {
  const schema = unwrapNullable(input);
  const type = schemaType(schema);
  if (type === "array") {
    return "collection";
  }
  if (objectFormOfUnion(schema)) {
    return "object";
  }
  if (type !== "object" || schema.anyOf || schema.oneOf || schema.enum) {
    return "scalar";
  }
  const additional = objectAdditionalPropertiesSchema(schema);
  return objectPropertyKeys(schema).length === 0 && additional && typeof additional === "object"
    ? "collection"
    : "object";
}

const significantWords = (label: string) =>
  new Set(
    label
      .toLowerCase()
      .split(/[^\p{L}\p{N}]+/u)
      .filter((word) => word.length > 2),
  );

/** An object holding one setting needs no disclosure if that setting's label still reads alone. */
function loneSettingKey(
  schema: JsonSchema,
  path: Array<string | number>,
  hints: ConfigNodeRenderParams["hints"],
): string | undefined {
  const object = unwrapNullable(schema);
  const keys = objectPropertyKeys(object);
  const key = keys[0];
  const child = key === undefined ? undefined : objectPropertySchema(object, key);
  if (
    keys.length !== 1 ||
    key === undefined ||
    !child ||
    objectAdditionalPropertiesSchema(object) ||
    configFieldShape(child) !== "scalar"
  ) {
    return undefined;
  }
  const words = significantWords(resolveConfigFieldMeta([...path, key], child, hints).label);
  const shared = [...significantWords(resolveConfigFieldMeta(path, object, hints).label)].some(
    (word) => words.has(word),
  );
  return shared ? key : undefined;
}

function onlyGroupKey(schema: JsonSchema): string | undefined {
  const keys = objectPropertyKeys(schema);
  const shapes = keys.map((key) => configFieldShape(objectPropertySchema(schema, key) ?? {}));
  return !shapes.includes("scalar") && shapes.filter((shape) => shape === "object").length === 1
    ? keys[shapes.indexOf("object")]
    : undefined;
}

/**
 * Help of objects that render in place under this one. The row or section that remains takes
 * it on, so their words stay available.
 */
export function collectLiftedHelp(
  schema: JsonSchema,
  path: Array<string | number>,
  hints: ConfigNodeRenderParams["hints"],
): string[] {
  const object = unwrapNullable(schema);
  const key = onlyGroupKey(object);
  const child = key === undefined ? undefined : objectPropertySchema(object, key);
  if (key === undefined || !child) {
    return [];
  }
  const childPath = [...path, key];
  if (loneSettingKey(child, childPath, hints)) {
    return [];
  }
  const help = resolveConfigFieldMeta(childPath, child, hints).help;
  return [...(help ? [help] : []), ...collectLiftedHelp(child, childPath, hints)];
}
export function resolveConfigObjectFields(params: ConfigNodeRenderParams) {
  const { schema, value, path, hints, onPatch, onRemove, searchCriteria } = params;
  const selfMatched =
    searchCriteria && hasSearchCriteria(searchCriteria)
      ? matchesNodeSelf({ schema, path, hints, criteria: searchCriteria })
      : false;
  const childSearchCriteria = selfMatched ? undefined : searchCriteria;
  const inherited = value === undefined && schema.default !== undefined;
  // A string here is shorthand for the object's primary field; an edit writes the full object.
  const shorthand = typeof value === "string" ? { primary: value } : undefined;
  const fallback = inherited ? schema.default : (shorthand ?? value);
  const objectSourceIdentity = fallback === undefined ? UNSET_MAP_SOURCE_IDENTITY : fallback;
  const objectValue = asNonArrayRecord(fallback);
  const entries = objectPropertyKeys(schema)
    .map((key) => [key, objectPropertySchema(schema, key)] as const)
    .filter((entry): entry is readonly [string, ConfigNodeRenderParams["schema"]] =>
      Boolean(entry[1]),
    );
  const requiredKeys = requiredPropertyKeys(schema);
  // A SecretRef's redacted id is a reference, so its parts never become replaceable secrets.
  const secretRefOptions = isSecretRefObject(objectValue)
    ? { secretFields: undefined, replaceStoredSecrets: undefined }
    : {};

  // Only a level with a surface for lifted help may dissolve its one group.
  const hasHelpSurface =
    params.sectionRoot === true ||
    params.inlineObject !== undefined ||
    (params.showLabel !== false && path.length !== 1);
  const onlyGroup = hasHelpSurface ? onlyGroupKey(unwrapNullable(schema)) : undefined;
  const inlineMode = ([key, node]: readonly [string, JsonSchema]) =>
    loneSettingKey(node, [...path, key], hints)
      ? ("lone-setting" as const)
      : key === onlyGroup
        ? ("only-group" as const)
        : undefined;
  // Prepare each field once; sorting otherwise repeats schema and translated-label work.
  const sorted = entries
    .map(([key, node]) => {
      const inline = inlineMode([key, node]);
      return {
        key,
        node,
        inline,
        shapeOrder: inline ? SHAPE_ORDER.scalar : SHAPE_ORDER[configFieldShape(node)],
        hint: hintForPath([...path, key], hints),
      };
    })
    .toSorted((left, right) => {
      const shapeOrder = left.shapeOrder - right.shapeOrder;
      if (shapeOrder !== 0) {
        return shapeOrder;
      }
      if (left.shapeOrder === SHAPE_ORDER.object) {
        const modelOrder = modelGroupRank(left.key) - modelGroupRank(right.key);
        if (modelOrder !== 0) {
          return modelOrder;
        }
      }
      const advancedOrder =
        Number(left.hint?.advanced === true) - Number(right.hint?.advanced === true);
      if (advancedOrder !== 0) {
        return advancedOrder;
      }
      const hintOrder = (left.hint?.order ?? 0) - (right.hint?.order ?? 0);
      if (hintOrder !== 0) {
        return hintOrder;
      }
      // A group opened on its own leads with the switch that decides whether the rest applies.
      if (params.collapseObjects && (left.key === "enabled" || right.key === "enabled")) {
        return left.key === "enabled" ? -1 : 1;
      }
      return left.key.localeCompare(right.key);
    });

  const reservedKeys = new Set(entries.map(([key]) => key));
  const additionalProperties = objectAdditionalPropertiesSchema(schema);
  const allowExtra = Boolean(additionalProperties) && typeof additionalProperties === "object";
  const patchObjectChild = (childPath: Array<string | number>, childValue: unknown) => {
    if (
      childPath.length < path.length ||
      !path.every((segment, index) => segment === childPath[index])
    ) {
      return false;
    }
    const relativePath = childPath.slice(path.length);
    // An emptied field of a string-or-object setting is gone, not stored as an empty string.
    const nextValue = params.shorthandObject && childValue === "" ? undefined : childValue;
    const patched = copyWithPathPatch(objectValue, relativePath, nextValue);
    if (!patched.ok || !isRecord(patched.value)) {
      return false;
    }
    const candidate = patched.value;
    if (!canApplyObjectCandidate(schema, objectValue, candidate)) {
      return false;
    }
    if (params.shorthandObject && Object.keys(candidate).length === 0) {
      return (onRemove ? onRemove(path) : onPatch(path, undefined)) !== false;
    }
    if (inherited || shorthand) {
      return onPatch(path, candidate) !== false;
    }
    const accepted =
      nextValue === undefined && onRemove ? onRemove(childPath) : onPatch(childPath, nextValue);
    return accepted !== false;
  };

  // A row this object renders becomes the heading its fields sit under.
  const contextLabel =
    params.showLabel !== false && path.length !== 1 && !params.inlineObject
      ? resolveConfigFieldMeta(path, schema, hints).label
      : params.contextLabel;
  const ownHelp =
    params.inlineObject === "lone-setting"
      ? resolveConfigFieldMeta(path, schema, hints).help
      : undefined;
  const helpContext = ownHelp ? [...(params.helpContext ?? []), ownHelp] : params.helpContext;

  return {
    fields: sorted.map(({ key: propertyKey, node, inline }) => {
      const hasInheritedChild = inherited && Object.hasOwn(objectValue, propertyKey);
      return Object.assign(configChildRenderOptions(params), {
        contextLabel,
        helpContext,
        inlineObject: inline,
        schema: hasInheritedChild ? { ...node, default: objectValue[propertyKey] } : node,
        value: inherited ? undefined : objectValue[propertyKey],
        path: [...path, propertyKey],
        isRequired: requiredKeys.has(propertyKey),
        sourceIdentity: inherited ? undefined : objectValue[propertyKey],
        controlIdentity: params.controlIdentity ?? objectValue,
        searchCriteria: childSearchCriteria,
        ...secretRefOptions,
        onPatch: patchObjectChild,
      }) satisfies ConfigNodeRenderParams;
    }),
    additional: allowExtra
      ? {
          ...params,
          contextLabel,
          schema: additionalProperties,
          value: objectValue,
          sourceIdentity: objectSourceIdentity,
          reservedKeys,
          validateKey: (key: string) => isObjectPropertyNameValid(schema, key),
          searchCriteria: childSearchCriteria,
          onPatch: patchObjectChild,
        }
      : null,
  };
}
