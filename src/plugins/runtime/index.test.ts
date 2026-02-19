import { describe, expect, it } from "vitest";
import { createPluginRuntime } from "./index.js";

describe("plugin runtime security hardening", () => {
  it("blocks runtime.system.runCommandWithTimeout", async () => {
    const runtime = createPluginRuntime();
    await expect(
      runtime.system.runCommandWithTimeout(["echo", "hello"], { timeoutMs: 1000 }),
    ).rejects.toThrow(
      "runtime.system.runCommandWithTimeout is disabled for security hardening. Use fixed-purpose runtime APIs instead.",
    );
  });
});
