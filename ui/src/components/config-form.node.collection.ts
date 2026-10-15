import { asNonArrayRecord, isRecord } from "@openclaw/normalization-core/record-coerce";
import { removePathValue, setPathValue } from "../lib/config-form-utils.ts";
import {
  canApplyObjectCandidate,
  isObjectPropertyNameValid,
  objectAdditionalPropertiesSchema,
  objectPropertyKeys,
  objectPropertySchema,
  requiredPropertyKeys,
} from "./config-form.constraints.ts";
import { configChildRenderOptions } from "./config-form.node.shared.ts";
import type { ConfigNodeRenderParams } from "./config-form.node.shared.ts";
import {
  hasConfigSearchCriteria as hasSearchCriteria,
  matchesNodeSelf,
} from "./config-form.search.ts";
import { hintForPath } from "./config-form.shared.ts";

const UNSET_MAP_SOURCE_IDENTITY = Symbol("unset-map-source");
export function resolveConfigObjectFields(params: ConfigNodeRenderParams) {
  const { schema, value, path, hints, onPatch, onRemove, searchCriteria } = params;
  const selfMatched =
    searchCriteria && hasSearchCriteria(searchCriteria)
      ? matchesNodeSelf({ schema, path, hints, criteria: searchCriteria })
      : false;
  const childSearchCriteria = selfMatched ? undefined : searchCriteria;
  const inherited = value === undefined && schema.default !== undefined;
  const fallback = inherited ? schema.default : value;
  const objectSourceIdentity = fallback === undefined ? UNSET_MAP_SOURCE_IDENTITY : fallback;
  const objectValue = asNonArrayRecord(fallback);
  const entries = objectPropertyKeys(schema)
    .map((key) => [key, objectPropertySchema(schema, key)] as const)
    .filter((entry): entry is readonly [string, ConfigNodeRenderParams["schema"]] =>
      Boolean(entry[1]),
    );
  const requiredKeys = requiredPropertyKeys(schema);

  const sorted = entries.toSorted((left, right) => {
    const leftOrder = hintForPath([...path, left[0]], hints)?.order ?? 0;
    const rightOrder = hintForPath([...path, right[0]], hints)?.order ?? 0;
    if (leftOrder !== rightOrder) {
      return leftOrder - rightOrder;
    }
    return left[0].localeCompare(right[0]);
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
    let candidate: Record<string, unknown>;
    const relativePath = childPath.slice(path.length);
    if (relativePath.length === 0) {
      if (!isRecord(childValue)) {
        return false;
      }
      candidate = childValue;
    } else {
      try {
        candidate = structuredClone(objectValue);
      } catch {
        return false;
      }
      if (childValue === undefined) {
        removePathValue(candidate, relativePath);
      } else {
        setPathValue(candidate, relativePath, childValue);
      }
    }
    if (!canApplyObjectCandidate(schema, objectValue, candidate)) {
      return false;
    }
    if (inherited) {
      return onPatch(path, candidate) !== false;
    }
    const accepted =
      childValue === undefined && onRemove ? onRemove(childPath) : onPatch(childPath, childValue);
    return accepted !== false;
  };

  return {
    fields: sorted.map(([propertyKey, node]) => {
      const hasInheritedChild = inherited && Object.hasOwn(objectValue, propertyKey);
      return Object.assign(configChildRenderOptions(params), {
        schema: hasInheritedChild ? { ...node, default: objectValue[propertyKey] } : node,
        value: inherited ? undefined : objectValue[propertyKey],
        path: [...path, propertyKey],
        isRequired: requiredKeys.has(propertyKey),
        sourceIdentity: inherited ? undefined : objectValue[propertyKey],
        controlIdentity: params.controlIdentity ?? objectValue,
        searchCriteria: childSearchCriteria,
        onPatch: patchObjectChild,
      }) satisfies ConfigNodeRenderParams;
    }),
    additional: allowExtra
      ? {
          ...params,
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
