import vm from "node:vm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  annotateRuntimeExecutionError,
  getRuntimeExecutionProfile,
  noteRuntimeDynamicExecution,
  noteRuntimePluginExecution,
} from "./runtime-profile.js";

vi.mock("../../cli-invocation.mjs", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../cli-invocation.mjs")>()),
  isEmbeddedStandaloneModule: (filename: string) => filename === "/image/plugin.js",
}));

beforeEach(() => {
  vi.stubGlobal("__openclawStandaloneBuildInfo", {
    mode: "aot",
    openclaw: { version: "test" },
    bun: { version: "test" },
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("runtime execution profiles", () => {
  it("allows dynamic code and reports each interpreted feature once, excluding embedded plugins", () => {
    expect(getRuntimeExecutionProfile()).toBe("embedded-aot");
    const warning = vi.spyOn(process, "emitWarning").mockImplementation(() => {});
    try {
      noteRuntimePluginExecution("/image/plugin.js");
      expect(warning).not.toHaveBeenCalled();
      for (let i = 0; i < 2; i++) {
        noteRuntimePluginExecution("/downloaded/plugin.ts");
        noteRuntimeDynamicExecution("code-mode");
        noteRuntimeDynamicExecution("qa");
      }
      expect(warning).toHaveBeenCalledTimes(3);
      expect(warning.mock.calls.map(([message]) => message)).toEqual([
        "Fetched plugin code runs interpreted in this AOT build; use a JIT build for full speed.",
        "Node Code Mode runs interpreted in this AOT build; use a JIT build for full speed.",
        "QA expression code runs interpreted in this AOT build; use a JIT build for full speed.",
      ]);
    } finally {
      warning.mockRestore();
    }
  });

  it("preserves ordinary execution errors", () => {
    const error = new TypeError("plugin callback failed");
    expect(annotateRuntimeExecutionError(error, "Plugin")).toBe(error);
  });

  it("explains a real code-generation rejection from another VM realm", () => {
    let rejected: unknown;
    try {
      vm.runInNewContext(
        "eval(source)",
        { source: "21 * 2" },
        {
          contextCodeGeneration: { strings: false, wasm: false },
        },
      );
    } catch (error) {
      rejected = error;
    }
    expect(rejected).toBeDefined();
    const annotated = annotateRuntimeExecutionError(rejected, "VM execution");
    expect(annotated).toBeInstanceOf(Error);
    expect(annotated).toHaveProperty("cause", rejected);
    expect(String(annotated)).toMatch(
      /code generation is disabled.*--disallow-code-generation-from-strings/,
    );
  });

  it("adds install/rebuild guidance to a real unavailable late import", async () => {
    let rejected: unknown;
    try {
      const missing = "/openclaw-synthetic-missing/plugin.mjs";
      await import(missing);
    } catch (error) {
      rejected = error;
    }
    expect(rejected).toBeDefined();
    expect(String(annotateRuntimeExecutionError(rejected, "Late import"))).toMatch(
      /not available in this AOT build.*Install missing code on disk.*rebuild.*JIT/,
    );
  });
});
