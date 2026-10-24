import {
  jsonSchemaValuesEqual,
  mapJsonSchema,
  type JsonSchemaRefinement,
  type JsonSchemaValue,
} from "@openclaw/normalization-core/json-schema";
import {
  createJsonSchemaValidator,
  type JsonSchemaValidator as PreparedValidator,
} from "@openclaw/normalization-core/json-schema-validator";
import { Meta } from "typebox/schema";
import { findJsonSchemaShapeError } from "./json-schema-defaults.js";
import {
  collectJsonSchemaResources,
  prepareJsonSchemaWithResources,
  resolveJsonSchemaResourceId,
  resolveJsonSchemaValidationId,
} from "./json-schema-resources.js";

const DRAFT_2020_12_SCHEMA = "https://json-schema.org/draft/2020-12/schema";
const DRAFT_7_SCHEMA = "http://json-schema.org/draft-07/schema#";
const draft7IgnoredKeywords = new Set([
  "$dynamicRef",
  "$recursiveAnchor",
  "$recursiveRef",
  "$vocabulary",
  "dependentRequired",
  "dependentSchemas",
  "enumIncludesNull",
  "maxContains",
  "minContains",
  "prefixItems",
  "unevaluatedItems",
  "unevaluatedProperties",
]);

type SchemaRegistry = {
  source: Map<string, JsonSchemaValue>;
  prepared: Map<string, JsonSchemaValue>;
  byId: Map<string, PreparedValidator>;
  bySchema: WeakMap<object, PreparedValidator>;
  formats: ReadonlyMap<string, JsonSchemaRefinement>;
};

function createRegistry(
  modern: boolean,
  formats: ReadonlyMap<string, JsonSchemaRefinement>,
): SchemaRegistry {
  const meta = modern ? Meta[DRAFT_2020_12_SCHEMA] : Meta[DRAFT_7_SCHEMA];
  const source = collectJsonSchemaResources(meta);
  const { schema: preparedMeta, resources: prepared } = prepareJsonSchemaWithResources(
    meta,
    formats,
  );
  if (!modern) {
    // Ajv's default draft-07 engine also registers this historical metaschema alias.
    source.set("http://json-schema.org/schema", meta);
    prepared.set("http://json-schema.org/schema", preparedMeta);
  }
  return { source, prepared, byId: new Map(), bySchema: new WeakMap(), formats };
}

function validatorContext(
  resources: ReadonlyMap<string, JsonSchemaValue>,
): Record<string, JsonSchemaValue> {
  return Object.fromEntries(
    [...resources].flatMap(([id, schema]): Array<[string, JsonSchemaValue]> =>
      id.includes("#")
        ? [[id, schema]]
        : [
            [id, schema],
            [`${id}#`, schema],
          ],
    ),
  );
}

function acquireValidator(
  registry: SchemaRegistry,
  schema: Exclude<JsonSchemaValue, boolean>,
  modern: boolean,
): PreparedValidator {
  const cached = registry.bySchema.get(schema);
  if (cached) {
    return cached;
  }
  const id =
    typeof schema.$id === "string" ? resolveJsonSchemaResourceId(schema.$id, undefined) : undefined;
  const validationId = id === undefined ? undefined : resolveJsonSchemaValidationId(id);
  const registered = validationId === undefined ? undefined : registry.prepared.get(validationId);
  if (!modern && id !== undefined && registered !== undefined) {
    let existing = registry.byId.get(id);
    if (!existing) {
      existing = createJsonSchemaValidator(
        { $ref: resolveJsonSchemaValidationId(id) },
        { context: validatorContext(registry.prepared) },
      );
      registry.byId.set(id, existing);
    }
    registry.bySchema.set(schema, existing);
    return existing;
  }
  // The former default engine was draft-07 even for undeclared/unknown dialects.
  // Do not start asserting newer keywords that it treated as annotations.
  const source = modern
    ? schema
    : mapJsonSchema(schema, (node, ancestors) => {
        const legacy = Object.fromEntries(
          Object.entries(node).filter(([key]) => !draft7IgnoredKeywords.has(key)),
        );
        if (typeof node.$id === "string" && typeof node.$ref === "string") {
          let base: string | undefined;
          for (const ancestor of [...ancestors, node]) {
            if (typeof ancestor.$id === "string") {
              base = resolveJsonSchemaResourceId(ancestor.$id, base);
            }
          }
          const ref = resolveJsonSchemaResourceId(node.$ref, base);
          // The old Ajv engine applied a same-node ID before resolving its reference.
          if (URL.canParse(ref)) {
            legacy.$ref = ref;
          }
        }
        return legacy;
      });
  const sourceResources = collectJsonSchemaResources(source, { rejectDuplicateIds: !modern });
  const schemaError = findJsonSchemaShapeError(source, {
    resources: new Map([...registry.source, ...sourceResources]),
    resolveId: resolveJsonSchemaResourceId,
  });
  if (schemaError) {
    throw new Error(schemaError);
  }
  for (const [resourceId, resource] of sourceResources) {
    const previous = registry.source.get(resourceId);
    if (
      !modern &&
      registry.byId.has(resourceId) &&
      previous !== undefined &&
      !jsonSchemaValuesEqual(previous, resource)
    ) {
      throw new Error(`JSON Schema resource already registered: ${resourceId}`);
    }
  }
  const { schema: prepared, resources: preparedResources } = prepareJsonSchemaWithResources(
    source,
    registry.formats,
  );
  const resources = new Map([...registry.prepared, ...preparedResources]);
  const validator = createJsonSchemaValidator(prepared, {
    context: validatorContext(resources),
  });
  for (const [resourceId, resource] of sourceResources) {
    registry.source.set(resourceId, resource);
  }
  registry.prepared = resources;
  registry.bySchema.set(schema, validator);
  if (id !== undefined) {
    registry.byId.set(id, validator);
  }
  return validator;
}

export type JsonSchemaValidatorProvider = {
  getValidator(schema: JsonSchemaValue): PreparedValidator;
};

/** Owns dialect preparation, reference registration, and cached codegen-free checks. */
export function createJsonSchemaValidatorProvider(options: {
  dialect: "draft7" | "2020-12";
  formats: ReadonlyMap<string, JsonSchemaRefinement>;
}): JsonSchemaValidatorProvider {
  const modern = options.dialect === "2020-12";
  const registry = createRegistry(modern, options.formats);
  return {
    getValidator(schema) {
      return typeof schema === "boolean"
        ? createJsonSchemaValidator(schema)
        : acquireValidator(registry, schema, modern);
    },
  };
}
