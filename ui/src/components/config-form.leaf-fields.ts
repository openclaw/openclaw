import { resolveStructuredDraftInitialValue } from "./config-form-structured-draft.ts";
import { resolveConfigObjectFields } from "./config-form.node.collection.ts";
import { isSecretRefObject, type ConfigNodeRenderParams } from "./config-form.node.shared.ts";
import { resolveConfigFieldMeta } from "./config-form.search.ts";
import { pathKey, schemaType } from "./config-form.shared.ts";

/** One editable setting from a flattened config object, labeled with its ancestors. */
export type ConfigLeafField = ConfigNodeRenderParams & {
  label: string;
  help?: string;
  /** The top-level property the leaf belongs to, for grouping and filtering. */
  property: string;
};

/** Expands closed config objects into leaf rows so no row hosts a nested object form. */
export function flattenConfigLeafFields(
  params: ConfigNodeRenderParams,
  rootProperty: string,
  ancestors: string[] = [],
): ConfigLeafField[] {
  const { label, help } = resolveConfigFieldMeta(params.path, params.schema, params.hints);
  const labels = [...ancestors, label];
  const initial = resolveStructuredDraftInitialValue(params);
  // SecretRef metadata stays atomic; source/provider/id are not child settings.
  if (
    schemaType(params.schema) === "object" &&
    params.schema.properties &&
    Object.keys(params.schema.properties).length > 0 &&
    params.schema.additionalProperties === false &&
    !params.schema.anyOf &&
    !params.schema.oneOf &&
    !params.schema.enum &&
    !isSecretRefObject(params.value) &&
    !params.unsupported.has(pathKey(params.path)) &&
    initial === undefined
  ) {
    return resolveConfigObjectFields(params).fields.flatMap((field) =>
      flattenConfigLeafFields(field, rootProperty, labels),
    );
  }
  return [{ ...params, property: rootProperty, label: labels.join(": "), help }];
}
