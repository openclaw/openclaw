import { afterEach, expect, it, vi } from "vitest";
import { resolveRuntimeExecutionProfile } from "../../standalone-runtime-profile.mjs";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.resetModules();
});

it.each([
  [undefined, "dynamic-execution"],
  [{ mode: "jit" as const }, "dynamic-execution"],
  [{ mode: "bytecode" as const }, "dynamic-execution"],
  [{ mode: "aot" as const }, "embedded-aot"],
] as const)("selects the execution profile from image build facts %j", (build, expected) => {
  expect(resolveRuntimeExecutionProfile(build)).toBe(expected);
});

it("keeps the selected image profile if later metadata changes", async () => {
  vi.stubGlobal("__openclawStandaloneBuildInfo", { mode: "aot" });
  const { getRuntimeExecutionProfile } = await import("../../standalone-runtime-profile.mjs");
  expect(getRuntimeExecutionProfile()).toBe("embedded-aot");
  vi.stubGlobal("__openclawStandaloneBuildInfo", { mode: "jit" });
  expect(getRuntimeExecutionProfile()).toBe("embedded-aot");
});
