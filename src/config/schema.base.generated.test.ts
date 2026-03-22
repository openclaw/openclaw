import { describe, expect, it } from "vitest";
import { computeBaseConfigSchemaResponse } from "./schema-base.js";
import { GENERATED_BASE_CONFIG_SCHEMA } from "./schema.base.generated.js";

describe("generated base config schema", () => {
  it("matches the computed base config schema payload", () => {
    expect(
      computeBaseConfigSchemaResponse({
        generatedAt: GENERATED_BASE_CONFIG_SCHEMA.generatedAt,
      }),
    ).toEqual(GENERATED_BASE_CONFIG_SCHEMA);
  });
});
