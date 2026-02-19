import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { installScheduledTask, readScheduledTaskCommand } from "./schtasks.js";

const schtasksCalls: string[][] = [];

vi.mock("./schtasks-exec.js", () => ({
  execSchtasks: async (argv: string[]) => {
    schtasksCalls.push(argv);
    return { code: 0, stdout: "", stderr: "" };
  },
}));

beforeEach(() => {
  schtasksCalls.length = 0;
});

describe("installScheduledTask", () => {
  it("writes quoted set assignments and escapes metacharacters", async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-schtasks-install-"));
    try {
      const env = {
        USERPROFILE: tmpDir,
        OPENCLAW_PROFILE: "default",
      };
      const { scriptPath } = await installScheduledTask({
        env,
        stdout: new PassThrough(),
        programArguments: ["node", "gateway.js", "--verbose"],
        environment: {
          OC_INJECT: "safe & whoami | calc",
          OC_CARET: "a^b",
          OC_PERCENT: "%TEMP%",
          OC_BANG: "!token!",
          OC_QUOTE: 'he said "hi"',
        },
      });

      const script = await fs.readFile(scriptPath, "utf8");
      expect(script).toContain('set "OC_INJECT=safe & whoami | calc"');
      expect(script).toContain('set "OC_CARET=a^^b"');
      expect(script).toContain('set "OC_PERCENT=%%TEMP%%"');
      expect(script).toContain('set "OC_BANG=^!token^!"');
      expect(script).toContain('set "OC_QUOTE=he said ^"hi^""');
      expect(script).not.toContain("set OC_INJECT=");

      const parsed = await readScheduledTaskCommand(env);
      expect(parsed?.environment).toMatchObject({
        OC_INJECT: "safe & whoami | calc",
        OC_CARET: "a^b",
        OC_PERCENT: "%TEMP%",
        OC_BANG: "!token!",
        OC_QUOTE: 'he said "hi"',
      });

      expect(schtasksCalls[0]).toEqual(["/Query"]);
      expect(schtasksCalls[1]?.[0]).toBe("/Create");
      expect(schtasksCalls[2]).toEqual(["/Run", "/TN", "OpenClaw Gateway"]);
    } finally {
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  });
});
