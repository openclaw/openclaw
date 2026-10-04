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

it.each(["/etc/openclaw/native.json", "C:\\OpenClaw\\native.json"])(
  "accepts an absolute node-local inference configuration path=%s",
  (nativeInferenceConfig) => {
    const result = validateConfigObject({ nodeHost: { workerRuns: { nativeInferenceConfig } } });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.config.nodeHost?.workerRuns?.nativeInferenceConfig).toBe(nativeInferenceConfig);
    }
  },
);

it.each(["native.json", "~/native.json", "", "/private/\0native.json", true, null])(
  "rejects invalid node-local inference configuration path=%j",
  (nativeInferenceConfig) => {
    const result = validateConfigObject({ nodeHost: { workerRuns: { nativeInferenceConfig } } });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(
        result.issues.some((issue) => issue.path === "nodeHost.workerRuns.nativeInferenceConfig"),
      ).toBe(true);
    }
  },
);
