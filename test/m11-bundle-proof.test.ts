import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import AjvPkg from "ajv";
import { describe, expect, it } from "vitest";

const Ajv = AjvPkg as unknown as new (opts?: object) => import("ajv").default;

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

type ValidationResult = {
  ok: boolean;
  errors: Array<{
    instancePath?: string;
    keyword?: string;
    params?: Record<string, unknown>;
  }>;
};

function readJson(relativePath: string): unknown {
  return JSON.parse(fs.readFileSync(path.join(repoRoot, relativePath), "utf8"));
}

function validate(schemaPath: string, dataPath: string): ValidationResult {
  const ajv = new Ajv({ allErrors: true, strict: false });
  const schema = readJson(schemaPath);
  const data = readJson(dataPath);
  const compiled = ajv.compile(schema);
  const ok = compiled(data);
  return {
    ok,
    errors: (compiled.errors ?? []).map((error) => ({
      instancePath: error.instancePath,
      keyword: error.keyword,
      params: error.params as Record<string, unknown>,
    })),
  };
}

describe("M11 engineering seat bundle proof", () => {
  const cleanPairs = [
    [
      "schemas/agent.lineage.schema.json",
      "examples/engineering-seat-bundle/clean/agent.lineage.json",
    ],
    [
      "schemas/agent.runtime.schema.json",
      "examples/engineering-seat-bundle/clean/agent.runtime.json",
    ],
    [
      "schemas/agent.policy.schema.json",
      "examples/engineering-seat-bundle/clean/agent.policy.json",
    ],
  ] as const;

  it("validates the clean engineering seat bundle", () => {
    for (const [schemaPath, dataPath] of cleanPairs) {
      const result = validate(schemaPath, dataPath);
      expect(result.ok, `${dataPath} should validate against ${schemaPath}`).toBe(true);
      expect(result.errors).toEqual([]);
    }
  });

  it("rejects runtime truth sourced from UI state", () => {
    const result = validate(
      "schemas/agent.runtime.schema.json",
      "examples/engineering-seat-bundle/known-bad-ui-state/agent.runtime.json",
    );

    expect(result.ok).toBe(false);
    expect(result.errors).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          instancePath: "",
          keyword: "additionalProperties",
          params: expect.objectContaining({ additionalProperty: "uiState" }),
        }),
        expect.objectContaining({
          instancePath: "/runtimeTruthSource",
          keyword: "const",
        }),
      ]),
    );
  });
});
