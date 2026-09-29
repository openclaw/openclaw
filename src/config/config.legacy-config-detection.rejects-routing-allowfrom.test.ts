import { expect, it } from "vitest";
import { validateConfigObject } from "./validation-core.js";

it("flags a gateway.bind host alias as legacy", () => {
  const result = validateConfigObject({ gateway: { bind: "0.0.0.0" } });
  expect(result.ok).toBe(false);
  if (!result.ok) {
    expect(result.issues.some((issue) => issue.path === "gateway.bind")).toBe(true);
  }
});
