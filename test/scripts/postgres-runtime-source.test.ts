import { describe, expect, it } from "vitest";
import { generateStatePostgresRuntimeSource } from "../../scripts/lib/postgres-runtime-source.mts";

describe("PostgreSQL runtime constants", () => {
  it("preserves generated values and repeated-read identity", async () => {
    const fixture = {
      eagerSql: "CREATE TABLE sample (value text DEFAULT 'literal');\n",
      fragments: [{ id: "sample", tables: ["sample"], dependencies: [] }],
      expectedCatalog: [{ table: "sample", kind: "column", value: { nullable: false } }],
    };
    const source = generateStatePostgresRuntimeSource(fixture);
    const { statePostgresRuntime: runtime } = await import(
      `data:text/javascript,${encodeURIComponent(source)}`
    );

    expect(runtime.eagerSql).toBe(fixture.eagerSql);
    const catalog = runtime.expectedCatalog;
    expect(runtime.expectedCatalog).toBe(catalog);
    expect(structuredClone(runtime)).toEqual(fixture);
  });
});
