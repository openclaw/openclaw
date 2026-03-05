import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { VERSION } from "../version.js";
import {
  installScheduledTask,
  readScheduledTaskCommand,
  resolveTaskScriptPath,
  restartScheduledTask,
} from "./schtasks.js";

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
  async function withUserProfileDir(
    run: (tmpDir: string, env: Record<string, string>) => Promise<void>,
  ) {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-schtasks-install-"));
    const env = {
      USERPROFILE: tmpDir,
      OPENCLAW_PROFILE: "default",
    };
    try {
      await run(tmpDir, env);
    } finally {
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  }

  it("writes quoted set assignments and escapes metacharacters", async () => {
    await withUserProfileDir(async (_tmpDir, env) => {
      const { scriptPath } = await installScheduledTask({
        env,
        stdout: new PassThrough(),
        programArguments: [
          "node",
          "gateway.js",
          "--display-name",
          "safe&whoami",
          "--percent",
          "%TEMP%",
          "--bang",
          "!token!",
        ],
        workingDirectory: "C:\\temp\\poc&calc",
        environment: {
          OC_INJECT: "safe & whoami | calc",
          OC_CARET: "a^b",
          OC_PERCENT: "%TEMP%",
          OC_BANG: "!token!",
          OC_QUOTE: 'he said "hi"',
          OC_EMPTY: "",
        },
      });

      const script = await fs.readFile(scriptPath, "utf8");
      expect(script).toContain('cd /d "C:\\temp\\poc&calc"');
      expect(script).toContain(
        'node gateway.js --display-name "safe&whoami" --percent "%%TEMP%%" --bang "^!token^!"',
      );
      expect(script).toContain('set "OC_INJECT=safe & whoami | calc"');
      expect(script).toContain('set "OC_CARET=a^^b"');
      expect(script).toContain('set "OC_PERCENT=%%TEMP%%"');
      expect(script).toContain('set "OC_BANG=^!token^!"');
      expect(script).toContain('set "OC_QUOTE=he said ^"hi^""');
      expect(script).not.toContain('set "OC_EMPTY=');
      expect(script).not.toContain("set OC_INJECT=");

      const parsed = await readScheduledTaskCommand(env);
      expect(parsed).toMatchObject({
        programArguments: [
          "node",
          "gateway.js",
          "--display-name",
          "safe&whoami",
          "--percent",
          "%TEMP%",
          "--bang",
          "!token!",
        ],
        workingDirectory: "C:\\temp\\poc&calc",
      });
      expect(parsed?.environment).toMatchObject({
        OC_INJECT: "safe & whoami | calc",
        OC_CARET: "a^b",
        OC_PERCENT: "%TEMP%",
        OC_BANG: "!token!",
        OC_QUOTE: 'he said "hi"',
      });
      expect(parsed?.environment).not.toHaveProperty("OC_EMPTY");

      expect(schtasksCalls[0]).toEqual(["/Query"]);
      expect(schtasksCalls[1]?.[0]).toBe("/Create");
      expect(schtasksCalls[2]).toEqual(["/Run", "/TN", "OpenClaw Gateway"]);
    });
  });

  it("rejects line breaks in command arguments, env vars, and descriptions", async () => {
    await withUserProfileDir(async (_tmpDir, env) => {
      await expect(
        installScheduledTask({
          env,
          stdout: new PassThrough(),
          programArguments: ["node", "gateway.js", "bad\narg"],
          environment: {},
        }),
      ).rejects.toThrow(/Command argument cannot contain CR or LF/);

      await expect(
        installScheduledTask({
          env,
          stdout: new PassThrough(),
          programArguments: ["node", "gateway.js"],
          environment: { BAD: "line1\r\nline2" },
        }),
      ).rejects.toThrow(/Environment variable value cannot contain CR or LF/);

      await expect(
        installScheduledTask({
          env,
          stdout: new PassThrough(),
          description: "bad\ndescription",
          programArguments: ["node", "gateway.js"],
          environment: {},
        }),
      ).rejects.toThrow(/Task description cannot contain CR or LF/);
    });
  });
});

describe("restartScheduledTask", () => {
  async function withUserProfileDir(
    run: (tmpDir: string, env: Record<string, string>) => Promise<void>,
  ) {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-schtasks-restart-"));
    const env = {
      USERPROFILE: tmpDir,
      OPENCLAW_PROFILE: "default",
    };
    try {
      await run(tmpDir, env);
    } finally {
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  }

  it("refreshes OPENCLAW_SERVICE_VERSION in gateway.cmd before restarting task", async () => {
    await withUserProfileDir(async (_tmpDir, env) => {
      const scriptPath = resolveTaskScriptPath(env);
      await fs.mkdir(path.dirname(scriptPath), { recursive: true });
      await fs.writeFile(
        scriptPath,
        [
          "@echo off",
          "rem OpenClaw Gateway",
          "set OPENCLAW_SERVICE_VERSION=2026.2.26",
          "set NODE_ENV=production",
          "node gateway.js --port 18789",
        ].join("\r\n"),
        "utf8",
      );

      await restartScheduledTask({
        env,
        stdout: new PassThrough(),
      });

      const script = await fs.readFile(scriptPath, "utf8");
      expect(script).toContain(`set "OPENCLAW_SERVICE_VERSION=${VERSION}"`);
      expect(script).not.toContain("set OPENCLAW_SERVICE_VERSION=2026.2.26");
      expect(schtasksCalls).toEqual([
        ["/Query"],
        ["/End", "/TN", "OpenClaw Gateway"],
        ["/Run", "/TN", "OpenClaw Gateway"],
      ]);
    });
  });
});
