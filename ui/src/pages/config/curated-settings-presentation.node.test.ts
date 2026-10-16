import { readFileSync } from "node:fs";
import { asNullableRecord } from "@openclaw/normalization-core/record-coerce";
import { describe, expect, it } from "vitest";
import { registerSettingsEnglish } from "../../i18n/locales/en-settings.ts";
import { curatedSettingsPresentation } from "./curated-settings-presentation.ts";

const presentation = curatedSettingsPresentation("memory-dreaming-settings");
const manifestPath = "../../../../extensions/memory-core/openclaw.plugin.json";
const manifest: unknown = JSON.parse(readFileSync(new URL(manifestPath, import.meta.url), "utf8"));

function schemaAtPath(value: unknown, path: readonly string[]): Record<string, unknown> {
  let schema = asNullableRecord(value);
  for (const key of path) {
    schema = asNullableRecord(asNullableRecord(schema?.properties)?.[key]);
  }
  if (!schema) {
    throw new Error(`Missing manifest schema: ${path.join(".")}`);
  }
  return schema;
}

describe("Memory Core settings placement presentation", () => {
  it("owns every curated field without changing its runtime schema", () => {
    expect(presentation.presentationOwner).toBe(asNullableRecord(manifest)?.id);
    const seen = new Set<string>();
    for (const section of presentation.sections) {
      for (const field of section.fields) {
        const path = field.path.join(".");
        expect(seen.has(path)).toBe(false);
        seen.add(path);
        const schema = schemaAtPath(asNullableRecord(manifest)?.configSchema, [
          "dreaming",
          ...field.path,
        ]);
        if (field.kind === "number") {
          expect(field.bounds).toEqual({
            integer: schema.type === "integer",
            min: schema.minimum,
            ...(schema.maximum === undefined ? {} : { max: schema.maximum }),
          });
        }
        if (field.kind === "segmented") {
          expect(field.options.map((option) => option.value)).toEqual(schema.enum);
          expect(schema.enum).toContain(field.displayDefault);
        }
        for (const key of [field.labelKey, field.helpKey]) {
          const label = key
            .split(".")
            .reduce<unknown>(
              (value, part) =>
                value && typeof value === "object" ? Reflect.get(value, part) : undefined,
              registerSettingsEnglish.catalog,
            );
          expect(typeof label).toBe("string");
          expect(label).not.toBe("");
        }
      }
    }
    expect(seen.size).toBe(22);
  });
});
