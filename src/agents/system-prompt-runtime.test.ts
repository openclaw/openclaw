import { describe, expect, it } from "vitest";
import { buildRuntimeLine } from "./system-prompt-runtime.js";

const environment = {
  host: "gateway-a",
  arch: "x64",
  shell: "bash",
};

describe("Runtime prompt cache stability", () => {
  it.each([
    ["Linux 7.0.0-43-generic", "Linux 7.0.0-44-generic", "Linux"],
    ["macOS 26.0", "macOS 26.1", "macOS"],
    ["Windows_NT 10.0.26100", "Windows_NT 10.0.26200", "Windows_NT"],
  ])("keeps the same line across host updates from %s to %s", (before, after, osName) => {
    const initial = buildRuntimeLine({ ...environment, os: before, node: "v24.22.2" });
    const updated = buildRuntimeLine({ ...environment, os: after, node: "v24.22.3" });

    expect(updated).toBe(initial);
    expect(updated).toBe(`Runtime: host=gateway-a | os=${osName} (x64) | shell=bash`);
  });

  it.each([{ host: "gateway-b" }, { shell: "zsh" }])(
    "keeps execution context changes visible: %j",
    (changed) => {
      const runtimeInfo = { ...environment, os: "Linux 7.0.0-44-generic", node: "v24.22.3" };
      expect(buildRuntimeLine({ ...runtimeInfo, ...changed })).not.toBe(
        buildRuntimeLine(runtimeInfo),
      );
    },
  );

  it("keeps architecture when the OS label is blank", () => {
    expect(buildRuntimeLine({ arch: "arm64", os: " \t ", node: "v24.22.3" })).toBe(
      "Runtime: arch=arm64",
    );
  });
});
