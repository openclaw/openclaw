import { afterEach, describe, expect, it, vi } from "vitest";
import type { RuntimeExecutionProfile } from "../../standalone-runtime-profile.mjs";

const profile = vi.hoisted((): { value: RuntimeExecutionProfile } => ({
  value: "dynamic-execution",
}));
vi.mock("../../standalone-runtime-profile.mjs", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../standalone-runtime-profile.mjs")>()),
  getRuntimeExecutionProfile: () => profile.value,
}));
afterEach(() => vi.restoreAllMocks());

describe.each(["dynamic-execution", "embedded-aot"] as const)(
  "plugin config validation on %s",
  (runtimeProfile) => {
    it("preserves references, formats, defaults and independent cached checks", async () => {
      profile.value = runtimeProfile;
      vi.resetModules();
      const { validateJsonSchemaValue } = await import("./schema-validator.js");
      if (runtimeProfile === "embedded-aot") {
        vi.spyOn(globalThis, "Function").mockImplementation(() => {
          throw new Error("string code generation is disabled");
        });
      }
      const schema = {
        type: "object",
        $defs: { endpoint: { type: "string", format: "uri" } },
        properties: {
          endpoint: { $ref: "#/$defs/endpoint" },
          contact: { type: "string", format: "email" },
          count: { type: ["integer", "null"], default: 3 },
        },
        required: ["endpoint", "contact"],
        additionalProperties: false,
      };
      const value = { endpoint: "https://example.test", contact: "annotation only" };
      expect(validateJsonSchemaValue({ schema, value, applyDefaults: true })).toEqual({
        ok: true,
        value: { ...value, count: 3 },
      });
      expect(validateJsonSchemaValue({ schema, value: { ...value, endpoint: "invalid" } }).ok).toBe(
        false,
      );
      const union = {
        type: "object",
        anyOf: [
          { properties: { a: { type: "number" } } },
          { properties: { b: { type: "number" } } },
        ],
        unevaluatedProperties: false,
      };
      expect(validateJsonSchemaValue({ schema: union, value: { a: 1 } }).ok).toBe(true);
      expect(validateJsonSchemaValue({ schema: union, value: { a: "invalid" } }).ok).toBe(false);
    });
  },
);
