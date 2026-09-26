import type { ConfigUiHints } from "../api/types.ts";
import { hintForPath, type JsonSchema } from "../lib/config-form-utils.ts";

type ConfigSchemaTierSplit = {
  common: JsonSchema | null;
  advanced: JsonSchema | null;
};

function projectSchemaTier(params: {
  schema: JsonSchema;
  path: string[];
  advanced: boolean;
  hints: ConfigUiHints;
}): JsonSchema | null {
  const { schema, path, advanced, hints } = params;
  if (Array.isArray(schema.items) || schema.additionalProperties === true) {
    return (hintForPath(path, hints)?.advanced ?? true) === advanced ? schema : null;
  }
  const properties: Record<string, JsonSchema> = {};
  let hasSchemaChildren = false;

  for (const [key, child] of Object.entries(schema.properties ?? {})) {
    hasSchemaChildren = true;
    const projected = projectSchemaTier({
      schema: child,
      path: [...path, key],
      advanced,
      hints,
    });
    if (projected) {
      properties[key] = projected;
    }
  }

  let additionalProperties = schema.additionalProperties;
  if (schema.additionalProperties && typeof schema.additionalProperties === "object") {
    hasSchemaChildren = true;
    additionalProperties =
      projectSchemaTier({
        schema: schema.additionalProperties,
        path: [...path, "*"],
        advanced,
        hints,
      }) ?? undefined;
  }

  let items = schema.items;
  if (schema.items) {
    hasSchemaChildren = true;
    items =
      projectSchemaTier({
        schema: schema.items,
        path: [...path, "*"],
        advanced,
        hints,
      }) ?? undefined;
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

/** Split one schema section into common and advanced projections. */
export function splitConfigSchemaByTier(params: {
  schema: JsonSchema;
  path: string[];
  hints: ConfigUiHints;
}): ConfigSchemaTierSplit {
  return {
    common: projectSchemaTier({ ...params, advanced: false }),
    advanced: projectSchemaTier({ ...params, advanced: true }),
  };
}
