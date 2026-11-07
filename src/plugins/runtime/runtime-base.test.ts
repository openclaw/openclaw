import { expect, it, vi } from "vitest";
import { createRuntimeBase } from "./runtime-base.js";
import { createRuntimeSystem } from "./runtime-system.js";

it("constructs the same system facade only when first requested", () => {
  const createSystem = vi.fn(createRuntimeSystem);
  const base = createRuntimeBase(createSystem);
  expect(createSystem).not.toHaveBeenCalled();
  const system = base.system;
  expect(base.system).toBe(system);
  expect(createSystem).toHaveBeenCalledTimes(1);
});

it("advertises command-scoped native subagents to installed plugins", () => {
  const capabilities = createRuntimeBase(createRuntimeSystem).capabilities;
  expect(capabilities).toContain("command-native-subagents-v1");
  expect(capabilities).toContain("native-subagent-list-v1");
  expect(capabilities?.every((capability) => typeof capability === "string")).toBe(true);
});

it("advertises scheduled command turns before plugins register commands that request them", () => {
  expect(createRuntimeBase(createRuntimeSystem).capabilities).toContain(
    "command-scheduled-turns-v1",
  );
});

it("advertises restart continuity so plugins do not re-enroll surviving schedules", () => {
  expect(createRuntimeBase(createRuntimeSystem).capabilities).toContain(
    "command-scheduled-turns-restart-v1",
  );
});
