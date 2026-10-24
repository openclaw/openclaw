import { describe, expect, it, vi } from "vitest";
import {
  assertRuntimeSupportsDynamicExecution,
  assertRuntimeSupportsPluginModule,
  getRuntimeExecutionProfile,
  resolveRuntimeExecutionProfile,
} from "./runtime-profile.js";

const manifest = vi.hoisted(() => ({ mode: "aot" as const }));
vi.mock("../../cli-invocation.mjs", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../cli-invocation.mjs")>()),
  getStandaloneRuntimeBuild: () => manifest,
  isEmbeddedStandaloneModule: (filename: string) => filename === "/image/plugin.js",
}));

describe("runtime execution profiles", () => {
  it.each([
    [undefined, "dynamic-execution"],
    [{ mode: "jit" as const }, "dynamic-execution"],
    [{ mode: "bytecode" as const }, "dynamic-execution"],
    [{ mode: "aot" as const }, "embedded-aot"],
  ] as const)("selects the profile from build facts %j", (build, expected) => {
    expect(resolveRuntimeExecutionProfile(build)).toBe(expected);
  });

  it("rejects host evaluation with an actionable runtime change", () => {
    expect(getRuntimeExecutionProfile()).toBe("embedded-aot");
    expect(() => assertRuntimeSupportsDynamicExecution("Custom evaluator")).toThrow(
      /Custom evaluator requires the dynamic-execution runtime profile.*Node\/Bun installation/,
    );
  });

  it("admits image modules and names the rebuild needed for fetched code", () => {
    expect(() => assertRuntimeSupportsPluginModule("/image/plugin.js")).not.toThrow();
    expect(() => assertRuntimeSupportsPluginModule("/image/fetched.js")).toThrow(
      /not embedded.*Rebuild the complete standalone artifact with this plugin/,
    );
  });
});
