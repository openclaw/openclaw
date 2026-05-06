import { spawnSync } from "node:child_process";
import { describe, expect, it, vi } from "vitest";

vi.mock("node:child_process", () => ({
  spawnSync: vi.fn(() => ({ status: 0 })),
}));

vi.mock("../infra/openclaw-root.js", () => ({
  resolveOpenClawPackageRoot: vi.fn(async () => "/tmp/openclaw-root"),
}));

vi.mock("../cli/completion-runtime.js", async () => {
  const actual = await vi.importActual<typeof import("../cli/completion-runtime.js")>(
    "../cli/completion-runtime.js",
  );
  return {
    ...actual,
    completionCacheExists: vi.fn(async () => false),
    resolveShellFromEnv: vi.fn(() => "powershell"),
  };
});

describe("doctor completion", () => {
  it("skips plugin command registration when doctor writes completion cache", async () => {
    const { ensureCompletionCacheExists } = await import("./doctor-completion.js");
    const { COMPLETION_SKIP_PLUGIN_COMMANDS_ENV } = await import("../cli/completion-runtime.js");

    await expect(ensureCompletionCacheExists()).resolves.toBe(true);

    expect(spawnSync).toHaveBeenCalledWith(
      process.execPath,
      ["/tmp/openclaw-root/openclaw.mjs", "completion", "--write-state"],
      expect.objectContaining({
        cwd: "/tmp/openclaw-root",
        env: expect.objectContaining({
          [COMPLETION_SKIP_PLUGIN_COMMANDS_ENV]: "1",
        }),
      }),
    );
  });
});
