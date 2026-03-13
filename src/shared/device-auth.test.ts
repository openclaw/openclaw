import { describe, expect, it } from "vitest";
import { normalizeDeviceAuthRole, normalizeDeviceAuthScopes } from "./device-auth.js";

describe("shared/device-auth", () => {
  it("trims device auth roles without further rewriting", () => {
    expect(normalizeDeviceAuthRole(" operator ")).toBe("operator");
    expect(normalizeDeviceAuthRole("")).toBe("");
  });

  it("dedupes, trims, sorts, and filters auth scopes", () => {
    expect(
      normalizeDeviceAuthScopes([" node.invoke ", "operator.read", "", "node.invoke", "a.scope"]),
    ).toEqual(["a.scope", "node.invoke", "operator.read"]);
    expect(normalizeDeviceAuthScopes(undefined)).toEqual([]);
  });
});
