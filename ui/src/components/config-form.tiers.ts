import type { ConfigUiHints } from "../api/types.ts";
import {
  hintForPath,
  objectFormOfUnion,
  schemaType,
  type JsonSchema,
} from "../lib/config-form-utils.ts";

type TierParams = {
  schema: JsonSchema;
  path: string[];
  advanced: boolean;
  hints: ConfigUiHints;
};

// Schema analysis normalizes maps to carry an empty properties object.
const hasFixedFields = (schema: JsonSchema) =>
  Object.keys(schema.properties ?? {}).length > 0 || objectFormOfUnion(schema) !== undefined;

/**
 * A map or list of objects is one setting. Splitting it by tier would list its entries, and
 * their Add button, once per tier, so it lives in the common tier if any of its fields do.
 */
function isObjectCollection(schema: JsonSchema): boolean {
  const item = Array.isArray(schema.items) ? undefined : schema.items;
  const additional =
    schema.additionalProperties && typeof schema.additionalProperties === "object"
      ? schema.additionalProperties
      : undefined;
  return (
    !hasFixedFields(schema) &&
    [item, additional].some((entry) => entry !== undefined && hasFixedFields(entry))
  );
}

function isCollection(schema: JsonSchema): boolean {
  return (
    schemaType(schema) === "array" ||
    (!hasFixedFields(schema) &&
      Boolean(schema.additionalProperties) &&
      schema.additionalProperties !== true)
  );
}

function projectSchemaTier(params: TierParams): JsonSchema | null {
  if (isObjectCollection(params.schema)) {
    return hasCommonField(params) === !params.advanced ? params.schema : null;
  }
  return projectSchemaFields(params);
}

function hasCommonField(params: TierParams): boolean {
  return projectSchemaFields({ ...params, advanced: false }) !== null;
}

/**
 * A nested object already waits behind its own disclosure, so it stays whole rather than
 * appearing once per tier. The one exception is a level holding nothing common but that object:
 * the form renders it in place, so the split continues inside it.
 */
function projectFormLevel(params: TierParams): JsonSchema | null {
  const { schema, path } = params;
  if (isObjectCollection(schema)) {
    return projectSchemaTier(params);
  }
  const children = Object.entries(schema.properties ?? {});
  const commonGroups = children.filter(
    ([key, child]) =>
      hasFixedFields(child) && hasCommonField({ ...params, schema: child, path: [...path, key] }),
  );
  // A list beside the object does not change that the object is the level's content.
  const hasCommonSetting = children.some(
    ([key, child]) =>
      !hasFixedFields(child) &&
      !isCollection(child) &&
      hasCommonField({ ...params, schema: child, path: [...path, key] }),
  );
  const inPlace = !hasCommonSetting && commonGroups.length === 1 ? commonGroups[0]?.[0] : undefined;
  return projectSchemaFields(params, (key, child) => {
    const childParams = { ...params, schema: child, path: [...path, key] };
    if (!hasFixedFields(child)) {
      return projectSchemaTier(childParams);
    }
    return key === inPlace
      ? projectFormLevel(childParams)
      : hasCommonField(childParams) === !params.advanced
        ? child
        : null;
  });
}

function projectSchemaFields(
  params: TierParams,
  projectProperty?: (key: string, child: JsonSchema) => JsonSchema | null,
): JsonSchema | null {
  const { schema, path, advanced, hints } = params;
  if (Array.isArray(schema.items) || schema.additionalProperties === true) {
    return (hintForPath(path, hints)?.advanced ?? true) === advanced ? schema : null;
  }
  const properties: Record<string, JsonSchema> = {};
  let hasSchemaChildren = false;
  const projectChild = (childSchema: JsonSchema, key: string) =>
    projectSchemaTier({ schema: childSchema, path: [...path, key], advanced, hints });

  for (const [key, child] of Object.entries(schema.properties ?? {})) {
    hasSchemaChildren = true;
    const projected = projectProperty ? projectProperty(key, child) : projectChild(child, key);
    if (projected) {
      properties[key] = projected;
    }
  }

  let additionalProperties = schema.additionalProperties;
  if (schema.additionalProperties && typeof schema.additionalProperties === "object") {
    hasSchemaChildren = true;
    additionalProperties = projectChild(schema.additionalProperties, "*") ?? undefined;
  }

  let items = schema.items;
  if (schema.items) {
    hasSchemaChildren = true;
    items = projectChild(schema.items, "*") ?? undefined;
  }

  const projectBranches = (branches: JsonSchema[] | undefined): JsonSchema[] | undefined => {
    if (!branches) {
      return undefined;
    }
    hasSchemaChildren = true;
    const projected = branches
      .map((branch) => projectSchemaTier({ schema: branch, path, advanced, hints }))
      .filter((projection) => projection !== null);
    return projected.length > 0 ? projected : undefined;
  };

  const anyOf = projectBranches(schema.anyOf);
  const oneOf = projectBranches(schema.oneOf);
  const allOf = projectBranches(schema.allOf);

  if (!hasSchemaChildren) {
    return (hintForPath(path, hints)?.advanced ?? true) === advanced ? schema : null;
  }

  const hasProjectedChildren =
    Object.keys(properties).length > 0 ||
    (additionalProperties !== undefined && additionalProperties !== false) ||
    (Array.isArray(items) ? items.length > 0 : Boolean(items)) ||
    Boolean(anyOf?.length || oneOf?.length || allOf?.length);
  if (!hasProjectedChildren) {
    return null;
  }

  const required = schema.required?.filter((key) => Object.hasOwn(properties, key));
  return {
    ...schema,
    ...(schema.properties ? { properties } : {}),
    ...(schema.required ? { required } : {}),
    ...(schema.additionalProperties !== undefined ? { additionalProperties } : {}),
    ...(schema.items !== undefined ? { items } : {}),
    ...(schema.anyOf ? { anyOf } : {}),
    ...(schema.oneOf ? { oneOf } : {}),
    ...(schema.allOf ? { allOf } : {}),
  };
}

export function splitConfigSchemaByTier(params: {
  schema: JsonSchema;
  path: string[];
  hints: ConfigUiHints;
}) {
  return {
    common: projectFormLevel({ ...params, advanced: false }),
    advanced: projectFormLevel({ ...params, advanced: true }),
  };
}
