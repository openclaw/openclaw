import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { html, nothing } from "lit";
import { schemaType, type JsonSchema } from "../../components/config-form.shared.ts";
import { analyzeConfigSchema, type ConfigSchemaAnalysis } from "../../components/config-form.ts";
import { t } from "../../i18n/index.ts";
import type { ConfigViewState } from "./view-types.ts";

export function asConfigSchema(value: unknown): JsonSchema | null {
  if (!isRecord(value)) {
    return null;
  }
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
    return visit((current as Record<string, unknown>)[segment], index + 1);
  };
  return visit(value, 0);
}

export function renderUnsupportedPathSummary(paths: string[]) {
  const marker = "__OPENCLAW_CONFIG_PATHS__";
  const key =
    paths.length === 1 ? "configView.formUnsafeCount" : "configView.formUnsafeCountPlural";
  const [prefix, suffix = ""] = t(key, {
    count: String(paths.length),
    paths: marker,
  }).split(marker);
  return html`
    <span class="config-content-callout__text">
      ${prefix}${paths
        .slice(0, 3)
        .map((path, index) => html`${index > 0 ? ", " : ""}<code>${path}</code>`)}${suffix}${
        paths.length > 3
          ? html` ${t("configView.formUnsafeMore", { count: String(paths.length - 3) })}`
          : nothing
      }
    </span>
  `;
}
