import { describe, expect, it } from "vitest";
import { z } from "zod";
import { buildChannelConfigSchema } from "./config-schema.js";

describe("buildChannelConfigSchema", () => {
  it("builds json schema when toJSONSchema is available", () => {
    const schema = z.object({ enabled: z.boolean().default(true) });
    const result = buildChannelConfigSchema(schema);
    expect(result.schema).toMatchObject({ type: "object" });
  });

  it("falls back when toJSONSchema is missing (zod v3 plugin compatibility)", () => {
    const legacySchema = {} as unknown as Parameters<typeof buildChannelConfigSchema>[0];
    const result = buildChannelConfigSchema(legacySchema);
    expect(result.schema).toEqual({ type: "object", additionalProperties: true });
  });
});
