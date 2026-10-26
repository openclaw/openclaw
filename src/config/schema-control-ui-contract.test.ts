import { expect, it } from "vitest";
import { analyzeConfigSchema } from "../../ui/src/components/config-form.analyze.js";
import type { JsonSchema } from "../../ui/src/components/config-form.shared.js";
import { computeBaseConfigSchemaResponse } from "./schema-base.js";

it("keeps native command settings editable as tri-state controls", () => {
  const raw = computeBaseConfigSchemaResponse({ generatedAt: "fixture" }).schema as JsonSchema;
  const analysis = analyzeConfigSchema(raw);
  for (const key of ["native", "nativeSkills"]) {
    const path = `commands.${key}`;
    expect(
      analysis.unsupportedPaths.some(
        (root) => root === "<root>" || path === root || path.startsWith(`${root}.`),
      ),
    ).toBe(false);
    expect(analysis.schema?.properties?.commands?.properties?.[key]).toMatchObject({
      enum: [true, false, "auto"],
      default: "auto",
    });
  }
});
