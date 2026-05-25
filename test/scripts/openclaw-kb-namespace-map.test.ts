import { describe, expect, it } from "vitest";
import {
  OPENCLAW_KB_NAMESPACE_MAP,
  namespaceForCategory,
  ontologyJsonToOpenApiSchemas,
  extractOntologyInstances,
} from "../../scripts/lib/openclaw-kb.mjs";

describe("openclaw-kb namespace map", () => {
  it("maps content subdirs to ClaWorks namespaces", () => {
    expect(namespaceForCategory("product_manual")).toBe("products");
    expect(namespaceForCategory("tender_document")).toBe("tender");
    expect(namespaceForCategory("other")).toBe("company");
    expect(OPENCLAW_KB_NAMESPACE_MAP.software_copyright).toBe("copyright");
    expect(OPENCLAW_KB_NAMESPACE_MAP.patent_design).toBe("patents");
  });

  it("converts ontology object_types to OpenAPI schemas", () => {
    const schemas = ontologyJsonToOpenApiSchemas({
      object_types: [
        {
          name: "Company",
          fields: [
            { name: "name", type: "string", required: true },
            { name: "cert_year", type: "integer" },
          ],
        },
      ],
    });
    expect(schemas.Company).toBeDefined();
    expect(schemas.Company.properties.name).toEqual({ type: "string" });
    expect(schemas.Company.required).toContain("name");
  });

  it("extracts entity instances by type_name", () => {
    const byType = extractOntologyInstances({
      entities: [
        { type_name: "Company", name: "Acme", cert: "ISO9001" },
        { type_name: "Company", name: "Beta" },
      ],
    });
    expect(byType.get("Company")).toHaveLength(2);
    expect(byType.get("Company")?.[0]).toEqual({ name: "Acme", cert: "ISO9001" });
  });
});
