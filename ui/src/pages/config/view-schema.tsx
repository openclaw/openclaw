import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { For, createMemo } from "solid-js";
import { schemaType, type JsonSchema } from "../../components/config-form.shared.ts";
import { analyzeConfigSchema, type ConfigSchemaAnalysis } from "../../components/config-form.ts";
import { t } from "../../lib/reactive/i18n.ts";
import type { ConfigViewState } from "./view-types.ts";

export function asConfigSchema(value: unknown): JsonSchema | null {
  if (!isRecord(value)) {
    return null;
  }
  // SAFETY: The schema comes from config.schema; the boundary check excludes non-object payloads.
  return value as JsonSchema;
}

export function getConfigSchemaAnalysis(
  viewState: ConfigViewState,
  schema: JsonSchema | null,
  include?: ReadonlySet<string> | null,
  exclude?: ReadonlySet<string> | null,
): ConfigSchemaAnalysis {
  const includeKey = include ? [...include].join("\u001f") : "";
  const excludeKey = exclude ? [...exclude].join("\u001f") : "";
  const cached = viewState.schemaAnalysisCache;
  if (
    cached &&
    cached.schema === schema &&
    cached.includeKey === includeKey &&
    cached.excludeKey === excludeKey
  ) {
    return cached.analysis;
  }
  let scopedSchema = schema;
  if (schema && schemaType(schema) === "object" && schema.properties) {
    const properties: Record<string, JsonSchema> = {};
    for (const [key, property] of Object.entries(schema.properties)) {
      if (property && (!include?.size || include.has(key)) && !exclude?.has(key)) {
        properties[key] = property;
      }
    }
    scopedSchema = { ...schema, properties };
  }
  const analysis = analyzeConfigSchema(scopedSchema);
  viewState.schemaAnalysisCache = { schema, includeKey, excludeKey, analysis };
  return analysis;
}

export function configValueExistsAtPath(
  value: Record<string, unknown> | null,
  pathString: string,
): boolean {
  if (!value || pathString === "<root>") {
    return false;
  }
  const segments = pathString.split(".");
  const visit = (current: unknown, index: number): boolean => {
    if (index === segments.length) {
      return current !== undefined;
    }
    if (current === null || typeof current !== "object") {
      return false;
    }
    const segment = segments[index];
    if (segment === "*") {
      return Object.values(current).some((entry) => visit(entry, index + 1));
    }
    if (!segment || !Object.hasOwn(current, segment)) {
      return false;
    }
    // SAFETY: The value is an object and the requested own property was checked above.
    return visit((current as Record<string, unknown>)[segment], index + 1);
  };
  return visit(value, 0);
}

export function UnsupportedPathSummary(props: { paths: string[] }) {
  const message = createMemo(() => {
    const marker = "__OPENCLAW_CONFIG_PATHS__";
    const key =
      props.paths.length === 1 ? "configView.formUnsafeCount" : "configView.formUnsafeCountPlural";
    return t(key, { count: String(props.paths.length), paths: marker }).split(marker);
  });
  return (
    <span class="config-content-callout__text">
      {message()[0]}
      <For each={props.paths.slice(0, 3)}>
        {(path, index) => (
          <>
            {index() > 0 ? ", " : ""}
            <code>{path}</code>
          </>
        )}
      </For>
      {message()[1] ?? ""}
      {props.paths.length > 3
        ? ` ${t("configView.formUnsafeMore", { count: String(props.paths.length - 3) })}`
        : null}
    </span>
  );
}
