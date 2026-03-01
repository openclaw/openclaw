import { hintForPath } from "@/lib/config-form-utils";
import { CONFIG_SECTIONS, getSectionMetaOrDefault } from "@/lib/config-sections";
import type { JsonSchema, ConfigUiHints } from "@/types/agents";
import { FormNode } from "./config-form-node";

type ConfigFormViewProps = {
  schema: JsonSchema;
  formValue: Record<string, unknown>;
  hints: ConfigUiHints;
  activeSection: string | null;
  searchQuery: string;
  onPatch: (path: Array<string | number>, value: unknown) => void;
  onRemove: (path: Array<string | number>) => void;
};

// Recursive search match against schema keys, titles, descriptions, enum values
function matchesSearch(
  key: string,
  schema: JsonSchema,
  hints: ConfigUiHints,
  path: Array<string | number>,
  term: string,
): boolean {
  const lower = term.toLowerCase();

  // Match key name
  if (key.toLowerCase().includes(lower)) {
    return true;
  }

  // Match label/title
  const hint = hintForPath(path, hints);
  if (hint?.label?.toLowerCase().includes(lower)) {
    return true;
  }
  if (schema.title?.toLowerCase().includes(lower)) {
    return true;
  }
  if (schema.description?.toLowerCase().includes(lower)) {
    return true;
  }

  // Match enum values
  if (schema.enum?.some((v) => String(v).toLowerCase().includes(lower))) {
    return true;
  }

  // Recurse into object properties
  if (schema.properties) {
    return Object.entries(schema.properties).some(([propKey, propSchema]) =>
      matchesSearch(propKey, propSchema, hints, [...path, propKey], term),
    );
  }

  return false;
}

export function ConfigFormView({
  schema,
  formValue,
  hints,
  activeSection,
  searchQuery,
  onPatch,
  onRemove,
}: ConfigFormViewProps) {
  const properties = schema.properties ?? {};

  // Determine which sections to show
  let sectionKeys: string[];
  if (activeSection) {
    sectionKeys = activeSection in properties ? [activeSection] : [];
  } else {
    // Sort by CONFIG_SECTIONS order, then remaining alphabetically
    const sectionOrder = CONFIG_SECTIONS.map((s) => s.key);
    sectionKeys = Object.keys(properties).toSorted((a, b) => {
      const ai = sectionOrder.indexOf(a);
      const bi = sectionOrder.indexOf(b);
      const oa = ai === -1 ? 999 : ai;
      const ob = bi === -1 ? 999 : bi;
      if (oa !== ob) {
        return oa - ob;
      }
      return a.localeCompare(b);
    });
  }

  // Filter by search query
  if (searchQuery) {
    sectionKeys = sectionKeys.filter((key) => {
      const sectionSchema = properties[key];
      if (!sectionSchema) {
        return false;
      }
      return matchesSearch(key, sectionSchema, hints, [key], searchQuery);
    });
  }

  // Also filter nested properties when searching
  const getFilteredSchema = (key: string, sectionSchema: JsonSchema): JsonSchema => {
    if (!searchQuery || !sectionSchema.properties) {
      return sectionSchema;
    }

    const term = searchQuery.toLowerCase();
    // If the section key itself matches, show all properties
    if (key.toLowerCase().includes(term)) {
      return sectionSchema;
    }

    const meta = getSectionMetaOrDefault(key);
    if (meta?.label.toLowerCase().includes(term)) {
      return sectionSchema;
    }

    // Filter to matching properties
    const filteredProps: Record<string, JsonSchema> = {};
    for (const [propKey, propSchema] of Object.entries(sectionSchema.properties)) {
      if (matchesSearch(propKey, propSchema, hints, [key, propKey], searchQuery)) {
        filteredProps[propKey] = propSchema;
      }
    }
    return { ...sectionSchema, properties: filteredProps };
  };

  // Sort properties within each section by hint order
  const getSortedSchema = (key: string, sectionSchema: JsonSchema): JsonSchema => {
    if (!sectionSchema.properties) {
      return sectionSchema;
    }

    const sortedEntries = Object.entries(sectionSchema.properties).toSorted(([a], [b]) => {
      const orderA = hintForPath([key, a], hints)?.order ?? 50;
      const orderB = hintForPath([key, b], hints)?.order ?? 50;
      if (orderA !== orderB) {
        return orderA - orderB;
      }
      return a.localeCompare(b);
    });

    const sorted: Record<string, JsonSchema> = {};
    for (const [k, v] of sortedEntries) {
      sorted[k] = v;
    }
    return { ...sectionSchema, properties: sorted };
  };

  if (sectionKeys.length === 0) {
    return (
      <div className="text-center py-12 text-muted-foreground text-sm">
        {searchQuery ? "No settings match your search." : "No settings available."}
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {sectionKeys.map((key) => {
        const sectionSchema = properties[key];
        if (!sectionSchema) {
          return null;
        }

        const meta = getSectionMetaOrDefault(key);
        const Icon = meta?.icon;
        const label = meta?.label ?? key;
        const description = meta?.description ?? sectionSchema.description;

        const filtered = getFilteredSchema(key, sectionSchema);
        const sorted = getSortedSchema(key, filtered);

        // Skip sections with no visible properties after filtering
        if (sorted.properties && Object.keys(sorted.properties).length === 0) {
          return null;
        }

        return (
          <section key={key} className="rounded-lg border border-border bg-card overflow-hidden">
            {/* Section header */}
            <div className="flex items-center gap-3 px-5 py-4 border-b border-border/50 bg-muted/20">
              {Icon && <Icon className="h-5 w-5 text-primary shrink-0" />}
              <div>
                <h2 className="text-sm font-semibold">{label}</h2>
                {description && (
                  <p className="text-xs text-muted-foreground mt-0.5">{description}</p>
                )}
              </div>
            </div>

            {/* Section content */}
            <div className="px-5 py-4">
              <FormNode
                schema={sorted}
                value={formValue[key]}
                path={[key]}
                hints={hints}
                onPatch={onPatch}
                onRemove={onRemove}
                depth={0}
              />
            </div>
          </section>
        );
      })}
    </div>
  );
}
