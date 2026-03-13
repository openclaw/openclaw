import { describe, expect, it, vi } from "vitest";
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

  it("passes draft-07 compatibility options to toJSONSchema", () => {
    const toJSONSchema = vi.fn(() => ({
      type: "object",
      properties: { enabled: { type: "boolean" } },
    }));
    const schema = { toJSONSchema } as unknown as Parameters<typeof buildChannelConfigSchema>[0];

    const result = buildChannelConfigSchema(schema);

    expect(toJSONSchema).toHaveBeenCalledWith({
      target: "draft-07",
      unrepresentable: "any",
    });
    expect(result.schema).toEqual({
      type: "object",
      properties: { enabled: { type: "boolean" } },
    });
  });
});
