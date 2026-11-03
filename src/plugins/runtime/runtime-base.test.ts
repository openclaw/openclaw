import { expect, it } from "vitest";
import { createRuntimeBase } from "./runtime-base.js";

it("advertises command-scoped native subagents to installed plugins", () => {
  const capabilities = createRuntimeBase().capabilities;
  expect(capabilities).toContain("command-native-subagents-v1");
  expect(capabilities).toContain("native-subagent-list-v1");
  expect(capabilities?.every((capability) => typeof capability === "string")).toBe(true);
});

it("advertises scheduled command turns before plugins register commands that request them", () => {
  expect(createRuntimeBase().capabilities).toContain("command-scheduled-turns-v1");
});

it("advertises restart continuity so plugins do not re-enroll surviving schedules", () => {
  expect(createRuntimeBase().capabilities).toContain("command-scheduled-turns-restart-v1");
});
