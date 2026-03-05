import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

const execSchtasksMock = vi.fn(async () => ({ code: 0, stdout: "", stderr: "" }));
vi.mock("./schtasks-exec.js", () => ({
  execSchtasks: execSchtasksMock,
}));

describe("installScheduledTask", () => {
  afterEach(() => {
    execSchtasksMock.mockClear();
  });

  it("writes OPENCLAW_SERVICE_VERSION into generated gateway.cmd", async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-schtasks-install-"));
    try {
      const { installScheduledTask, resolveTaskScriptPath } = await import("./schtasks.js");
      const env = { USERPROFILE: tmpDir, OPENCLAW_PROFILE: "default" };
      const stdout = { write: vi.fn() } as unknown as NodeJS.WriteStream;

      await installScheduledTask({
        env,
        stdout,
        programArguments: ["node", "gateway.js"],
        workingDirectory: "C:/openclaw",
        environment: { NODE_ENV: "production" },
      });

      const script = await fs.readFile(resolveTaskScriptPath(env), "utf8");
      expect(script).toContain("OPENCLAW_SERVICE_VERSION=");
      expect(script).toContain("node gateway.js");
    } finally {
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  });

  it("ignores stale OPENCLAW_SERVICE_VERSION overrides from environment", async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-schtasks-install-"));
    try {
      const { installScheduledTask, resolveTaskScriptPath } = await import("./schtasks.js");
      const env = { USERPROFILE: tmpDir, OPENCLAW_PROFILE: "default" };
      const stdout = { write: vi.fn() } as unknown as NodeJS.WriteStream;

      await installScheduledTask({
        env,
        stdout,
        programArguments: ["node", "gateway.js"],
        workingDirectory: "C:/openclaw",
        environment: {
          NODE_ENV: "production",
          OPENCLAW_SERVICE_VERSION: "stale-version-should-be-dropped",
        },
      });

      const script = await fs.readFile(resolveTaskScriptPath(env), "utf8");
      expect(script).toContain("OPENCLAW_SERVICE_VERSION=");
      expect(script).not.toContain("stale-version-should-be-dropped");
      expect((script.match(/OPENCLAW_SERVICE_VERSION=/g) || []).length).toBe(1);
    } finally {
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  });
});
