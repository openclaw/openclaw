import { asNonArrayRecord } from "@openclaw/normalization-core/record-coerce";
import { normalizeLowercaseStringOrEmpty } from "@openclaw/normalization-core/string-coerce";
import { normalizeTrimmedStringList } from "@openclaw/normalization-core/string-normalization";
import { indexFirstByKey } from "../../../src/shared/dedupe-by-key.ts";
import type { ConfigUiHints } from "../api/types.ts";
import {
  localizedHintForPath,
  humanize,
  schemaType,
  type JsonSchema,
} from "../lib/config-form-utils.ts";
import { arrayItemSchema, arrayItemSchemaIndexes } from "./config-form.array-items.ts";

export type ConfigSearchCriteria = {
  text: string;
  tags: string[];
};

type ConfigSearchTextMatcher = (value: string, query: string) => boolean;

export function hasConfigSearchCriteria(criteria: ConfigSearchCriteria | undefined): boolean {
  return Boolean(criteria && (criteria.text.length > 0 || criteria.tags.length > 0));
}

export function parseConfigSearchQuery(query: string): ConfigSearchCriteria {
  const tags = new Set<string>();
  const stripped = query.replace(/(?:^|\s)tag:([^\s]+)/gi, (_, token: string) => {
    const normalized = normalizeLowercaseStringOrEmpty(token);
    if (normalized) {
      tags.add(normalized);
    }
    return "";
  });
  return {
    text: normalizeLowercaseStringOrEmpty(stripped),
    tags: [...tags],
  };
}

function normalizeTags(raw: unknown): string[] {
  return [
    ...indexFirstByKey(normalizeTrimmedStringList(raw), normalizeLowercaseStringOrEmpty).values(),
  ];
}

export function resolveConfigFieldMeta(
  path: Array<string | number>,
  schema: JsonSchema,
  hints: ConfigUiHints,
) {
  const hint = localizedHintForPath(path, hints);
  const fallbackSegment = path.findLast((segment) => typeof segment === "string") ?? path.at(-1);
  const label = hint?.label ?? schema.title ?? humanize(String(fallbackSegment));
  const help = hint?.help ?? schema.description;
  const schemaTags = normalizeTags(schema["x-tags"] ?? schema.tags);
  const hintTags = normalizeTags(hint?.tags);
  return {
    label,
    help,
    tags: hintTags.length > 0 ? hintTags : schemaTags,
  };
}

function defaultTextMatcher(value: string, query: string): boolean {
  return normalizeLowercaseStringOrEmpty(value).includes(normalizeLowercaseStringOrEmpty(query));
}

function matchesTags(filterTags: string[], fieldTags: string[]): boolean {
  if (filterTags.length === 0) {
    return true;
  }
  const normalized = new Set(fieldTags.map((tag) => normalizeLowercaseStringOrEmpty(tag)));
  return filterTags.every((tag) => normalized.has(tag));
}

export function matchesNodeSelf(params: {
  schema: JsonSchema;
  path: Array<string | number>;
  hints: ConfigUiHints;
  criteria: ConfigSearchCriteria;
  textMatcher?: ConfigSearchTextMatcher;
}): boolean {
  const { schema, path, hints, criteria, textMatcher = defaultTextMatcher } = params;
  if (!hasConfigSearchCriteria(criteria)) {
    return true;
  }
  const { label, help, tags } = resolveConfigFieldMeta(path, schema, hints);
  if (!matchesTags(criteria.tags, tags)) {
    return false;
  }
  if (!criteria.text) {
    return true;
  }

  const pathLabel = path
    .filter((segment): segment is string => typeof segment === "string")
    .join(".");
  const enumText = schema.enum?.map((value) => String(value)).join(" ") ?? "";
  return [label, help, schema.title, schema.description, pathLabel, enumText].some(
    (candidate) => candidate !== undefined && textMatcher(candidate, criteria.text),
  );
}

export function matchesNodeSearch(params: {
  schema: JsonSchema;
  value: unknown;
  path: Array<string | number>;
  hints: ConfigUiHints;
  criteria: ConfigSearchCriteria;
  textMatcher?: ConfigSearchTextMatcher;
}): boolean {
  const { schema, value, path, hints, criteria, textMatcher = defaultTextMatcher } = params;
  if (matchesNodeSelf({ schema, path, hints, criteria, textMatcher })) {
    return true;
  }
  const matchesChild = (childSchema: JsonSchema, childValue: unknown, segment: string | number) =>
    matchesNodeSearch({
      ...params,
      schema: childSchema,
      value: childValue,
      path: [...path, segment],
    });

  const type = schemaType(schema);
  if (type === "object") {
    const fallback = value ?? schema.default;
    const obj = asNonArrayRecord(fallback);
    const properties = schema.properties ?? {};
    if (Object.entries(properties).some(([key, node]) => matchesChild(node, obj[key], key))) {
      return true;
    }
    const additional = schema.additionalProperties;
    if (additional && typeof additional === "object") {
      const reserved = new Set(Object.keys(properties));
      const dynamicEntries = Object.entries(obj).filter(([entryKey]) => !reserved.has(entryKey));
      if (dynamicEntries.length === 0) {
        return matchesChild(additional, undefined, "*");
      }
      return dynamicEntries.some(([key, entryValue]) => matchesChild(additional, entryValue, key));
    }
    return false;
  }

  if (type !== "array") {
    return false;
  }
  const values = Array.isArray(value) ? value : Array.isArray(schema.default) ? schema.default : [];
  const searchLength = Math.max(values.length, arrayItemSchemaIndexes(schema).length);
  for (let index = 0; index < searchLength; index += 1) {
    const itemSchema = arrayItemSchema(schema, index);
    if (itemSchema && matchesChild(itemSchema, values[index], index)) {
      return true;
    }
  }
  return false;
}

export function resolveConfigMapSearch(params: {
  schema: JsonSchema;
  value: Record<string, unknown>;
  path: Array<string | number>;
  hints: ConfigUiHints;
  reservedKeys: ReadonlySet<string>;
  searchCriteria?: ConfigSearchCriteria;
}) {
  const entries = Object.entries(params.value).filter(([key]) => !params.reservedKeys.has(key));
  const criteria = params.searchCriteria;
  const searching = hasConfigSearchCriteria(criteria);
  const visibleEntries =
    criteria && searching
      ? entries.filter(([key, value]) =>
          matchesNodeSearch({
            schema: params.schema,
            value,
            path: [...params.path, key],
            hints: params.hints,
            criteria,
          }),
        )
      : entries;
  return { visibleEntries, visible: !searching || visibleEntries.length > 0 };
}

export function matchesConfigSectionSearch(params: {
  key: string;
  schema: JsonSchema;
  value: unknown;
  hints: ConfigUiHints;
  query: string;
  label?: string;
  description?: string;
  textMatcher?: ConfigSearchTextMatcher;
}): boolean {
  if (!params.query) {
    return true;
  }
  const criteria = parseConfigSearchQuery(params.query);
  const metadataMatches =
    criteria.tags.length === 0 &&
    criteria.text.length > 0 &&
    [params.key, params.label, params.description].some((candidate) =>
      candidate !== undefined
        ? (params.textMatcher ?? defaultTextMatcher)(candidate, criteria.text)
        : false,
    );
  return (
    metadataMatches ||
    matchesNodeSearch({
      schema: params.schema,
      value: params.value,
      path: [params.key],
      hints: params.hints,
      criteria,
      textMatcher: params.textMatcher,
    })
  );
}
