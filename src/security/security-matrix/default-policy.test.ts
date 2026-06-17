import { describe, expect, it } from "vitest";
import { defaultSecurityMatrixPolicy } from "./default-policy.js";
import { evaluateSecurityMatrix } from "./evaluate.js";
import {
  SECURITY_MATRIX_DECISIONS,
  SECURITY_MATRIX_INFLUENCE_SOURCES,
  SECURITY_MATRIX_TOOL_CAPABILITIES,
} from "./types.js";

describe("defaultSecurityMatrixPolicy invariants", () => {
  it("declares a default rule for every capability without external influence", () => {
    for (const capability of SECURITY_MATRIX_TOOL_CAPABILITIES) {
      expect(defaultSecurityMatrixPolicy.none?.[capability]).toBeDefined();
    }
  });

  it("declares a default rule for every external influence and capability", () => {
    for (const source of SECURITY_MATRIX_INFLUENCE_SOURCES) {
      for (const capability of SECURITY_MATRIX_TOOL_CAPABILITIES) {
        expect(defaultSecurityMatrixPolicy[source]?.[capability]).toBeDefined();
      }
    }
  });

  it("produces deterministic default decisions for every declared matrix cell", () => {
    for (const capability of SECURITY_MATRIX_TOOL_CAPABILITIES) {
      const first = evaluateSecurityMatrix({ capability });
      const second = evaluateSecurityMatrix({ capability });

      expect(first).toMatchObject(second);
      expect(SECURITY_MATRIX_DECISIONS).toContain(first.decision);
      expect(first.matched).toBe("policy");
    }

    for (const source of SECURITY_MATRIX_INFLUENCE_SOURCES) {
      for (const capability of SECURITY_MATRIX_TOOL_CAPABILITIES) {
        const input = { influencedBy: [source], capability };
        const first = evaluateSecurityMatrix(input);
        const second = evaluateSecurityMatrix(input);

        expect(first).toMatchObject(second);
        expect(SECURITY_MATRIX_DECISIONS).toContain(first.decision);
        expect(first.matched).toBe("policy");
      }
    }
  });
});
