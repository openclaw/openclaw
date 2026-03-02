import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  buildPowerShellWrapper,
  parseSchtasksQuery,
  quotePowerShellArg,
  readScheduledTaskCommand,
  resolveTaskScriptPath,
} from "./schtasks.js";

describe("schtasks runtime parsing", () => {
  it.each(["Ready", "Running"])("parses %s status", (status) => {
    const output = [
      "TaskName: \\OpenClaw Gateway",
      `Status: ${status}`,
      "Last Run Time: 1/8/2026 1:23:45 AM",
      "Last Run Result: 0x0",
    ].join("\r\n");
    expect(parseSchtasksQuery(output)).toEqual({
      status,
      lastRunTime: "1/8/2026 1:23:45 AM",
      lastRunResult: "0x0",
    });
  });
});

describe("resolveTaskScriptPath", () => {
  it.each([
    {
      name: "uses default path when OPENCLAW_PROFILE is unset",
      env: { USERPROFILE: "C:\\Users\\test" },
      expected: path.join("C:\\Users\\test", ".openclaw", "gateway.cmd"),
    },
    {
      name: "uses profile-specific path when OPENCLAW_PROFILE is set to a custom value",
      env: { USERPROFILE: "C:\\Users\\test", OPENCLAW_PROFILE: "jbphoenix" },
      expected: path.join("C:\\Users\\test", ".openclaw-jbphoenix", "gateway.cmd"),
    },
    {
      name: "prefers OPENCLAW_STATE_DIR over profile-derived defaults",
      env: {
        USERPROFILE: "C:\\Users\\test",
        OPENCLAW_PROFILE: "rescue",
        OPENCLAW_STATE_DIR: "C:\\State\\openclaw",
      },
      expected: path.join("C:\\State\\openclaw", "gateway.cmd"),
    },
    {
      name: "falls back to HOME when USERPROFILE is not set",
      env: { HOME: "/home/test", OPENCLAW_PROFILE: "default" },
      expected: path.join("/home/test", ".openclaw", "gateway.cmd"),
    },
  ])("$name", ({ env, expected }) => {
    expect(resolveTaskScriptPath(env)).toBe(expected);
  });
});

describe("readScheduledTaskCommand", () => {
  async function withScheduledTaskScript(
    options: {
      scriptLines?: string[];
      env?:
        | Record<string, string | undefined>
        | ((tmpDir: string) => Record<string, string | undefined>);
    },
    run: (env: Record<string, string | undefined>) => Promise<void>,
  ) {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-schtasks-test-"));
    try {
      const extraEnv = typeof options.env === "function" ? options.env(tmpDir) : options.env;
      const env = {
        USERPROFILE: tmpDir,
        OPENCLAW_PROFILE: "default",
        ...extraEnv,
      };
      if (options.scriptLines) {
        const scriptPath = resolveTaskScriptPath(env);
        await fs.mkdir(path.dirname(scriptPath), { recursive: true });
        await fs.writeFile(scriptPath, options.scriptLines.join("\r\n"), "utf8");
      }
      await run(env);
    } finally {
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  }

  it("parses script with quoted arguments containing spaces", async () => {
    await withScheduledTaskScript(
      {
        // Use forward slashes which work in Windows cmd and avoid escape parsing issues.
        scriptLines: ["@echo off", '"C:/Program Files/Node/node.exe" gateway.js'],
      },
      async (env) => {
        const result = await readScheduledTaskCommand(env);
        expect(result).toEqual({
          programArguments: ["C:/Program Files/Node/node.exe", "gateway.js"],
        });
      },
    );
  });

  it("returns null when script does not exist", async () => {
    await withScheduledTaskScript({}, async (env) => {
      const result = await readScheduledTaskCommand(env);
      expect(result).toBeNull();
    });
  });

  it("returns null when script has no command", async () => {
    await withScheduledTaskScript(
      { scriptLines: ["@echo off", "rem This is just a comment"] },
      async (env) => {
        const result = await readScheduledTaskCommand(env);
        expect(result).toBeNull();
      },
    );
  });

  it("parses full script with all components", async () => {
    await withScheduledTaskScript(
      {
        scriptLines: [
          "@echo off",
          "rem OpenClaw Gateway",
          "cd /d C:\\Projects\\openclaw",
          "set NODE_ENV=production",
          "set OPENCLAW_PORT=18789",
          "node gateway.js --verbose",
        ],
      },
      async (env) => {
        const result = await readScheduledTaskCommand(env);
        expect(result).toEqual({
          programArguments: ["node", "gateway.js", "--verbose"],
          workingDirectory: "C:\\Projects\\openclaw",
          environment: {
            NODE_ENV: "production",
            OPENCLAW_PORT: "18789",
          },
        });
      },
    );
  });

  it("parses command with Windows backslash paths", async () => {
    await withScheduledTaskScript(
      {
        scriptLines: [
          "@echo off",
          '"C:\\Program Files\\nodejs\\node.exe" C:\\Users\\test\\AppData\\Roaming\\npm\\node_modules\\openclaw\\dist\\index.js gateway --port 18789',
        ],
      },
      async (env) => {
        const result = await readScheduledTaskCommand(env);
        expect(result).toEqual({
          programArguments: [
            "C:\\Program Files\\nodejs\\node.exe",
            "C:\\Users\\test\\AppData\\Roaming\\npm\\node_modules\\openclaw\\dist\\index.js",
            "gateway",
            "--port",
            "18789",
          ],
        });
      },
    );
  });

  it("preserves UNC paths in command arguments", async () => {
    await withScheduledTaskScript(
      {
        scriptLines: [
          "@echo off",
          '"\\\\fileserver\\OpenClaw Share\\node.exe" "\\\\fileserver\\OpenClaw Share\\dist\\index.js" gateway --port 18789',
        ],
      },
      async (env) => {
        const result = await readScheduledTaskCommand(env);
        expect(result).toEqual({
          programArguments: [
            "\\\\fileserver\\OpenClaw Share\\node.exe",
            "\\\\fileserver\\OpenClaw Share\\dist\\index.js",
            "gateway",
            "--port",
            "18789",
          ],
        });
      },
    );
  });

  it("reads script from OPENCLAW_STATE_DIR override", async () => {
    await withScheduledTaskScript(
      {
        env: (tmpDir) => ({ OPENCLAW_STATE_DIR: path.join(tmpDir, "custom-state") }),
        scriptLines: ["@echo off", "node gateway.js --from-state-dir"],
      },
      async (env) => {
        const result = await readScheduledTaskCommand(env);
        expect(result).toEqual({
          programArguments: ["node", "gateway.js", "--from-state-dir"],
        });
      },
    );
  });

  it("parses quoted set assignments with escaped metacharacters", async () => {
    await withScheduledTaskScript(
      {
        scriptLines: [
          "@echo off",
          'set "OC_AMP=left & right"',
          'set "OC_PIPE=a | b"',
          'set "OC_CARET=^^"',
          'set "OC_PERCENT=%%TEMP%%"',
          'set "OC_BANG=^!token^!"',
          'set "OC_QUOTE=he said ^"hi^""',
          "node gateway.js --verbose",
        ],
      },
      async (env) => {
        const result = await readScheduledTaskCommand(env);
        expect(result?.environment).toEqual({
          OC_AMP: "left & right",
          OC_PIPE: "a | b",
          OC_CARET: "^",
          OC_PERCENT: "%TEMP%",
          OC_BANG: "!token!",
          OC_QUOTE: 'he said "hi"',
        });
      },
    );
  });
});

describe("quotePowerShellArg", () => {
  it("wraps value in single quotes", () => {
    expect(quotePowerShellArg("node")).toBe("'node'");
  });

  it("escapes single quotes by doubling them", () => {
    expect(quotePowerShellArg("can't")).toBe("'can''t'");
    expect(quotePowerShellArg("it's")).toBe("'it''s'");
  });

  it("handles strings with spaces", () => {
    expect(quotePowerShellArg("Program Files")).toBe("'Program Files'");
  });

  it("handles paths with special characters", () => {
    expect(quotePowerShellArg("C:\\Users\\John's Folder")).toBe("'C:\\Users\\John''s Folder'");
  });
});

describe("buildPowerShellWrapper", () => {
  it("builds basic PowerShell script with command", () => {
    const script = buildPowerShellWrapper({
      programArguments: ["node", "gateway.js"],
    });
    expect(script).toContain("Start-Process -FilePath 'node'");
    expect(script).toContain("-ArgumentList @('gateway.js')");
    expect(script).toContain("-WindowStyle Hidden");
    expect(script).toContain("-Wait");
  });

  it("includes description as comment", () => {
    const script = buildPowerShellWrapper({
      description: "OpenClaw Node Host",
      programArguments: ["node", "gateway.js"],
    });
    expect(script).toContain("# OpenClaw Node Host");
  });

  it("sets working directory", () => {
    const script = buildPowerShellWrapper({
      programArguments: ["node", "gateway.js"],
      workingDirectory: "C:\\Projects\\openclaw",
    });
    expect(script).toContain("Set-Location 'C:\\Projects\\openclaw'");
  });

  it("sets environment variables", () => {
    const script = buildPowerShellWrapper({
      programArguments: ["node", "gateway.js"],
      environment: {
        NODE_ENV: "production",
        PORT: "18789",
      },
    });
    expect(script).toContain("$env:NODE_ENV = 'production'");
    expect(script).toContain("$env:PORT = '18789'");
  });

  it("handles command with no arguments", () => {
    const script = buildPowerShellWrapper({
      programArguments: ["notepad.exe"],
    });
    expect(script).toContain("Start-Process -FilePath 'notepad.exe'");
    expect(script).not.toContain("-ArgumentList");
    expect(script).toContain("-WindowStyle Hidden");
  });

  it("handles command with multiple arguments", () => {
    const script = buildPowerShellWrapper({
      programArguments: ["node", "gateway.js", "--port", "18789", "--verbose"],
    });
    expect(script).toContain("-ArgumentList @('gateway.js', '--port', '18789', '--verbose')");
  });

  it("builds complete script with all components", () => {
    const script = buildPowerShellWrapper({
      description: "OpenClaw Node Host (v2026.2.3-1)",
      programArguments: ["node", "gateway.js", "--port", "18789"],
      workingDirectory: "C:\\Projects\\openclaw",
      environment: {
        NODE_ENV: "production",
        OPENCLAW_PORT: "18789",
      },
    });
    expect(script).toContain("# OpenClaw Node Host (v2026.2.3-1)");
    expect(script).toContain("Set-Location 'C:\\Projects\\openclaw'");
    expect(script).toContain("$env:NODE_ENV = 'production'");
    expect(script).toContain("$env:OPENCLAW_PORT = '18789'");
    expect(script).toContain("Start-Process -FilePath 'node'");
    expect(script).toContain("-ArgumentList @('gateway.js', '--port', '18789')");
    expect(script).toContain("-WindowStyle Hidden");
  });

  it("escapes single quotes in arguments", () => {
    const script = buildPowerShellWrapper({
      programArguments: ["node", "gateway.js", "--name", "John's Gateway"],
    });
    expect(script).toContain("'John''s Gateway'");
  });

  it("uses CRLF line endings", () => {
    const script = buildPowerShellWrapper({
      programArguments: ["node", "gateway.js"],
    });
    expect(script).toContain("\r\n");
    expect(script.endsWith("\r\n")).toBe(true);
  });
});
