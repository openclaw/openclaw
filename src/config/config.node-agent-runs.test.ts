import { expect, it } from "vitest";
import { validateConfigObject } from "./validation-core.js";

it.each([
  ["capacity", 0],
  ["capacity", 1.5],
  ["capacity", 1025],
  ["enabled", "yes"],
  ["isolation", "docker"],
  ["containerImage", "   "],
])("rejects invalid worker hosting %s=%j", (field, value) => {
  const result = validateConfigObject({ nodeHost: { workerRuns: { [field]: value } } });
  expect(result.ok).toBe(false);
  if (!result.ok) {
    expect(result.issues.some((issue) => issue.path === `nodeHost.workerRuns.${field}`)).toBe(true);
  }
});
