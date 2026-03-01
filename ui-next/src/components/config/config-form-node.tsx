import { ChevronDown, ChevronRight, Plus, Trash2 } from "lucide-react";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { FormField, EnumField, NumberField, SecretInput } from "@/components/ui/custom/form";
import { Switch } from "@/components/ui/switch";
import { hintForPath, isSensitivePath, getFieldLabel, defaultValue } from "@/lib/config-form-utils";
import { schemaType, extractEnumValues, normalizeSchemaNode } from "@/lib/config-schema";
import { cn } from "@/lib/utils";
import type { JsonSchema, ConfigUiHints } from "@/types/agents";

// ============================================================
// Shared props for recursive rendering
// ============================================================

export type FormNodeProps = {
  schema: JsonSchema;
  value: unknown;
  path: Array<string | number>;
  hints: ConfigUiHints;
  onPatch: (path: Array<string | number>, value: unknown) => void;
  onRemove?: (path: Array<string | number>) => void;
  depth?: number;
};

// ============================================================
// FormNode — recursive dispatcher
// ============================================================

export function FormNode({
  schema,
  value,
  path,
  hints,
  onPatch,
  onRemove,
  depth = 0,
}: FormNodeProps) {
  const { schema: normalized } = normalizeSchemaNode(schema, path.map(String));
  const hint = hintForPath(path, hints);
  const label = getFieldLabel(path, normalized, hints);
  const description = hint?.help ?? normalized.description;
  const sensitive = hint?.sensitive ?? isSensitivePath(path);

  // Determine effective type
  const enumValues = extractEnumValues(normalized);
  if (enumValues) {
    return (
      <FormField label={label} description={description}>
        <EnumField options={enumValues} value={value} onChange={(v) => onPatch(path, v)} />
      </FormField>
    );
  }

  const effectiveType = schemaType(normalized);

  switch (effectiveType) {
    case "boolean":
      return (
        <div className="flex items-center justify-between py-1">
          <div className="space-y-0.5">
            <span className="text-sm font-medium">{label}</span>
            {description && <p className="text-xs text-muted-foreground">{description}</p>}
          </div>
          <Switch checked={Boolean(value)} onCheckedChange={(checked) => onPatch(path, checked)} />
        </div>
      );

    case "number":
    case "integer":
      return (
        <FormField label={label} description={description}>
          <NumberField
            value={typeof value === "number" ? value : 0}
            onChange={(v) => onPatch(path, v)}
            min={normalized.minimum}
            max={normalized.maximum}
          />
        </FormField>
      );

    case "string":
      if (sensitive) {
        return (
          <FormField label={label} description={description}>
            <SecretInput
              value={typeof value === "string" ? value : ""}
              onValueChange={(v) => onPatch(path, v)}
              placeholder={hint?.placeholder}
            />
          </FormField>
        );
      }
      return (
        <FormField label={label} description={description}>
          <input
            type="text"
            value={typeof value === "string" ? value : String((value as string) ?? "")}
            onChange={(e) => onPatch(path, e.target.value)}
            placeholder={hint?.placeholder}
            className={cn(
              "w-full rounded-md border bg-background px-3 py-1.5 text-sm",
              "focus:outline-none focus:ring-2 focus:ring-primary/30",
              "placeholder:text-muted-foreground/50",
            )}
          />
        </FormField>
      );

    case "object":
      return (
        <ObjectField
          schema={normalized}
          value={value as Record<string, unknown> | undefined}
          path={path}
          hints={hints}
          onPatch={onPatch}
          onRemove={onRemove}
          depth={depth}
          label={label}
          description={description}
        />
      );

    case "array":
      return (
        <ArrayField
          schema={normalized}
          value={value as unknown[] | undefined}
          path={path}
          hints={hints}
          onPatch={onPatch}
          label={label}
          description={description}
        />
      );

    default:
      // Fallback: render as JSON textarea for unknown/complex types
      return (
        <FormField label={label} description={description}>
          <textarea
            value={typeof value === "string" ? value : JSON.stringify(value ?? "", null, 2)}
            onChange={(e) => {
              try {
                onPatch(path, JSON.parse(e.target.value));
              } catch {
                onPatch(path, e.target.value);
              }
            }}
            rows={3}
            className={cn(
              "w-full rounded-md border bg-background px-3 py-2 text-sm font-mono",
              "focus:outline-none focus:ring-2 focus:ring-primary/30",
              "resize-y min-h-[60px]",
            )}
          />
        </FormField>
      );
  }
}

// ============================================================
// ObjectField — renders object properties, collapsible at depth > 0
// ============================================================

function ObjectField({
  schema,
  value,
  path,
  hints,
  onPatch,
  onRemove,
  depth,
  label,
  description,
}: {
  schema: JsonSchema;
  value: Record<string, unknown> | undefined;
  path: Array<string | number>;
  hints: ConfigUiHints;
  onPatch: (path: Array<string | number>, value: unknown) => void;
  onRemove?: (path: Array<string | number>) => void;
  depth: number;
  label: string;
  description?: string;
}) {
  const [collapsed, setCollapsed] = useState(depth > 1);
  const obj = value ?? {};
  const properties = schema.properties ?? {};

  // Sort by hint order, then alphabetically
  const sortedKeys = Object.keys(properties).toSorted((a, b) => {
    const orderA = hintForPath([...path, a], hints)?.order ?? 50;
    const orderB = hintForPath([...path, b], hints)?.order ?? 50;
    if (orderA !== orderB) {
      return orderA - orderB;
    }
    return a.localeCompare(b);
  });

  // additionalProperties support
  const hasAdditionalProps =
    typeof schema.additionalProperties === "object" && schema.additionalProperties !== null;
  const definedKeys = new Set(Object.keys(properties));
  const customKeys = Object.keys(obj).filter((k) => !definedKeys.has(k));

  const content = (
    <div className="space-y-4">
      {sortedKeys.map((key) => (
        <FormNode
          key={key}
          schema={properties[key]}
          value={obj[key]}
          path={[...path, key]}
          hints={hints}
          onPatch={onPatch}
          onRemove={onRemove}
          depth={depth + 1}
        />
      ))}

      {/* Custom entries from additionalProperties */}
      {hasAdditionalProps && customKeys.length > 0 && (
        <div className="space-y-3 pt-2 border-t border-border/30">
          <span className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">
            Custom Entries
          </span>
          {customKeys.map((key) => (
            <div key={key} className="flex items-start gap-2">
              <div className="flex-1">
                <FormNode
                  schema={schema.additionalProperties as JsonSchema}
                  value={obj[key]}
                  path={[...path, key]}
                  hints={hints}
                  onPatch={onPatch}
                  depth={depth + 1}
                />
              </div>
              <Button
                variant="ghost"
                size="icon-xs"
                onClick={() => onRemove?.([...path, key])}
                className="mt-6 text-muted-foreground hover:text-destructive shrink-0"
              >
                <Trash2 className="h-3.5 w-3.5" />
              </Button>
            </div>
          ))}
        </div>
      )}

      {hasAdditionalProps && (
        <AddCustomEntry
          path={path}
          schema={schema.additionalProperties as JsonSchema}
          existingKeys={new Set([...definedKeys, ...customKeys])}
          onPatch={onPatch}
        />
      )}
    </div>
  );

  // Top-level sections: flat, no wrapper
  if (depth === 0) {
    return content;
  }

  // Nested: collapsible
  return (
    <div className="rounded-lg border border-border/50 overflow-hidden">
      <button
        type="button"
        onClick={() => setCollapsed(!collapsed)}
        className="flex w-full items-center gap-2 px-3 py-2.5 bg-muted/30 hover:bg-muted/50 transition-colors"
      >
        {collapsed ? (
          <ChevronRight className="h-4 w-4 text-muted-foreground shrink-0" />
        ) : (
          <ChevronDown className="h-4 w-4 text-muted-foreground shrink-0" />
        )}
        <div className="text-left">
          <span className="text-sm font-medium">{label}</span>
          {description && <p className="text-xs text-muted-foreground mt-0.5">{description}</p>}
        </div>
      </button>
      {!collapsed && <div className="px-3 py-3">{content}</div>}
    </div>
  );
}

// ============================================================
// ArrayField — renders array items with add/remove
// ============================================================

function ArrayField({
  schema,
  value,
  path,
  hints,
  onPatch,
  label,
  description,
}: {
  schema: JsonSchema;
  value: unknown[] | undefined;
  path: Array<string | number>;
  hints: ConfigUiHints;
  onPatch: (path: Array<string | number>, value: unknown) => void;
  label: string;
  description?: string;
}) {
  const items = value ?? [];
  const itemSchema = Array.isArray(schema.items) ? schema.items[0] : schema.items;

  const addItem = () => {
    const newVal = defaultValue(itemSchema ?? { type: "string" });
    onPatch(path, [...items, newVal]);
  };

  const removeItem = (index: number) => {
    onPatch(
      path,
      items.filter((_, i) => i !== index),
    );
  };

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between">
        <div>
          <span className="text-sm font-medium">{label}</span>
          {description && <p className="text-xs text-muted-foreground">{description}</p>}
        </div>
        <div className="flex items-center gap-2">
          <span className="text-xs text-muted-foreground">{items.length} items</span>
          <Button variant="outline" size="sm" onClick={addItem} className="h-7 text-xs gap-1">
            <Plus className="h-3 w-3" />
            Add
          </Button>
        </div>
      </div>

      {items.length === 0 ? (
        <div className="rounded-md border border-dashed border-border/50 px-4 py-3 text-xs text-muted-foreground text-center">
          No items yet. Click Add to create one.
        </div>
      ) : (
        <div className="space-y-2">
          {items.map((item, i) => (
            <div key={i} className="flex items-start gap-2 pl-1">
              <span className="text-[10px] font-mono text-muted-foreground/60 mt-2.5 w-5 shrink-0">
                #{i + 1}
              </span>
              <div className="flex-1">
                {itemSchema ? (
                  <FormNode
                    schema={itemSchema}
                    value={item}
                    path={[...path, i]}
                    hints={hints}
                    onPatch={onPatch}
                    depth={2}
                  />
                ) : (
                  <input
                    type="text"
                    value={String((item as string) ?? "")}
                    onChange={(e) => onPatch([...path, i], e.target.value)}
                    className="w-full rounded-md border bg-background px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-primary/30"
                  />
                )}
              </div>
              <Button
                variant="ghost"
                size="icon-xs"
                onClick={() => removeItem(i)}
                className="mt-1 text-muted-foreground hover:text-destructive shrink-0"
              >
                <Trash2 className="h-3.5 w-3.5" />
              </Button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ============================================================
// AddCustomEntry — for additionalProperties
// ============================================================

function AddCustomEntry({
  path,
  schema,
  existingKeys,
  onPatch,
}: {
  path: Array<string | number>;
  schema: JsonSchema;
  existingKeys: Set<string>;
  onPatch: (path: Array<string | number>, value: unknown) => void;
}) {
  const [newKey, setNewKey] = useState("");

  const handleAdd = () => {
    const key = newKey.trim();
    if (!key || existingKeys.has(key)) {
      return;
    }
    onPatch([...path, key], defaultValue(schema));
    setNewKey("");
  };

  return (
    <div className="flex items-center gap-2 pt-1">
      <input
        type="text"
        value={newKey}
        onChange={(e) => setNewKey(e.target.value)}
        placeholder="New key..."
        onKeyDown={(e) => e.key === "Enter" && handleAdd()}
        className={cn(
          "flex-1 rounded-md border bg-background px-3 py-1.5 text-sm",
          "focus:outline-none focus:ring-2 focus:ring-primary/30",
          "placeholder:text-muted-foreground/50",
        )}
      />
      <Button
        variant="outline"
        size="sm"
        onClick={handleAdd}
        disabled={!newKey.trim() || existingKeys.has(newKey.trim())}
        className="h-8 text-xs gap-1"
      >
        <Plus className="h-3 w-3" />
        Add Entry
      </Button>
    </div>
  );
}
