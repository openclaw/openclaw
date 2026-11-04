import { assert } from "vitest";
import type { validateConfigObject } from "./validation-core.js";

type Result = ReturnType<typeof validateConfigObject>;
export function validatedConfig(result: Result) {
  assert(result.ok, "Expected valid config");
  return result.config;
}
export function validationIssues(result: Result) {
  assert(!result.ok, "Expected invalid config");
  return result.issues;
}
