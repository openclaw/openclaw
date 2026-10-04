import { describe, expect, it } from "vitest";
import {
  authorizeOperatorScopesForMethod,
  resolveLeastPrivilegeOperatorScopesForMethod,
} from "./method-scopes.js";

describe("dashboard default write scopes", () => {
  it("requires write scope for the dashboard default in single and bulk patches", () => {
    const boardPresentation = "expanded";
    for (const [method, params] of [
      ["sessions.patch", { key: "agent:main:dashboard", boardPresentation }],
      [
        "sessions.patchMany",
        { targets: [{ key: "agent:main:dashboard" }], patch: { boardPresentation } },
      ],
    ] as const) {
      expect(resolveLeastPrivilegeOperatorScopesForMethod(method, params)).toEqual([
        "operator.write",
      ]);
      expect(authorizeOperatorScopesForMethod(method, ["operator.read"], params)).toEqual({
        allowed: false,
        missingScope: "operator.write",
      });
    }
  });
});
