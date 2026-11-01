// @vitest-environment node
import { describe, expect, it } from "vitest";
import { formatModelRuntimeLabel } from "./model-runtime-label.ts";

describe("model runtime labels", () => {
  it.each([
    ["constructor", "Constructor"],
    ["__proto__", "__proto__"],
    ["codex", "Codex"],
  ])("formats %s as a text label", (runtimeId, label) => {
    expect(formatModelRuntimeLabel("openai", runtimeId)).toEqual({ label });
  });
});
