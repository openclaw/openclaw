import { expect, it } from "vitest";
import { createRuntimeBase } from "./runtime-base.js";

it("advertises command-scoped native subagents to installed plugins", () => {
  expect(createRuntimeBase().capabilities).toContain("command-native-subagents-v1");
});
