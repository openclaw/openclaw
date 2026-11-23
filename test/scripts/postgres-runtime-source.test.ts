import { describe, expect, it } from "vitest";
import { generatePostgresRuntimeSource } from "../../scripts/lib/postgres-runtime-source.mts";

describe("PostgreSQL runtime constants", () => {
  it.each(["statePostgresRuntime", "agentPostgresRuntime", "agentSearchPostgresRuntime"])(
    "preserves %s values and repeated-read identity",
    async (exportName) => {
      const fixture = {
        eagerSql: "CREATE TABLE sample (value text DEFAULT 'literal');\n",
        fragments: [{ id: "sample", tables: ["sample"], dependencies: [] }],
        expectedCatalog: [{ table: "sample", kind: "column", value: { nullable: false } }],
      };
      const source = generatePostgresRuntimeSource(exportName, fixture);
      const { [exportName]: runtime } = await import(
        `data:text/javascript,${encodeURIComponent(source)}`
      );

      for (const field of Object.keys(fixture)) {
        expect(Object.getOwnPropertyDescriptor(runtime, field)).toMatchObject({
          get: expect.any(Function),
        });
      }
      expect(runtime.eagerSql).toBe(fixture.eagerSql);
      const catalog = runtime.expectedCatalog;
      expect(runtime.expectedCatalog).toBe(catalog);
      expect(Object.getOwnPropertyDescriptor(runtime, "expectedCatalog")).toMatchObject({
        value: catalog,
        writable: true,
      });
      expect(structuredClone(runtime)).toEqual(fixture);
    },
  );
});
