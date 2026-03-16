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

describe("M13 internal bus bundle proof", () => {
  it("validates clean internal bus artifacts", () => {
    const cleanPairs = [
      [
        "schemas/agent-registry-entry.schema.json",
        "examples/internal-bus-bundle/clean/agent-registry-entry.json",
      ],
      ["schemas/internal-run.schema.json", "examples/internal-bus-bundle/clean/internal-run.json"],
    ] as const;

    for (const [schemaPath, dataPath] of cleanPairs) {
      const result = validate(schemaPath, dataPath);
      expect(result.ok, `${dataPath} should validate against ${schemaPath}`).toBe(true);
      expect(result.errors).toEqual([]);
    }
  });

  it("rejects invalid internal agent-registry state", () => {
    const result = validate(
      "schemas/agent-registry-entry.schema.json",
      "examples/internal-bus-bundle/known-bad-registry-state/agent-registry-entry.json",
    );

    expect(result.ok).toBe(false);
    expect(result.errors).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          instancePath: "/state",
          keyword: "enum",
        }),
      ]),
    );
  });

  it("rejects failed internal runs that omit required errorCode", () => {
    const result = validate(
      "schemas/internal-run.schema.json",
      "examples/internal-bus-bundle/known-bad-failed-run/internal-run.json",
    );

    expect(result.ok).toBe(false);
    expect(result.errors).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          instancePath: "/result",
          keyword: "required",
          params: expect.objectContaining({ missingProperty: "errorCode" }),
        }),
      ]),
    );
  });
});
