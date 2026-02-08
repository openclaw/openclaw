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
  it("parses status and last run info", () => {
    const output = [
      "TaskName: \\OpenClaw Gateway",
      "Status: Ready",
      "Last Run Time: 1/8/2026 1:23:45 AM",
      "Last Run Result: 0x0",
    ].join("\r\n");
    expect(parseSchtasksQuery(output)).toEqual({
      status: "Ready",
      lastRunTime: "1/8/2026 1:23:45 AM",
      lastRunResult: "0x0",
    });
  });

  it("parses running status", () => {
    const output = [
      "TaskName: \\OpenClaw Gateway",
      "Status: Running",
      "Last Run Time: 1/8/2026 1:23:45 AM",
      "Last Run Result: 0x0",
    ].join("\r\n");
    expect(parseSchtasksQuery(output)).toEqual({
      status: "Running",
      lastRunTime: "1/8/2026 1:23:45 AM",
      lastRunResult: "0x0",
    });
  });
});

describe("resolveTaskScriptPath", () => {
  it("uses default path when OPENCLAW_PROFILE is default", () => {
    const env = { USERPROFILE: "C:\\Users\\test", OPENCLAW_PROFILE: "default" };
    expect(resolveTaskScriptPath(env)).toBe(
      path.join("C:\\Users\\test", ".openclaw", "gateway.cmd"),
    );
  });

  it("uses default path when OPENCLAW_PROFILE is unset", () => {
    const env = { USERPROFILE: "C:\\Users\\test" };
    expect(resolveTaskScriptPath(env)).toBe(
      path.join("C:\\Users\\test", ".openclaw", "gateway.cmd"),
    );
  });

  it("uses profile-specific path when OPENCLAW_PROFILE is set to a custom value", () => {
    const env = { USERPROFILE: "C:\\Users\\test", OPENCLAW_PROFILE: "jbphoenix" };
    expect(resolveTaskScriptPath(env)).toBe(
      path.join("C:\\Users\\test", ".openclaw-jbphoenix", "gateway.cmd"),
    );
  });

  it("prefers OPENCLAW_STATE_DIR over profile-derived defaults", () => {
    const env = {
      USERPROFILE: "C:\\Users\\test",
      OPENCLAW_PROFILE: "rescue",
      OPENCLAW_STATE_DIR: "C:\\State\\openclaw",
    };
    expect(resolveTaskScriptPath(env)).toBe(path.join("C:\\State\\openclaw", "gateway.cmd"));
  });

  it("handles case-insensitive 'Default' profile", () => {
    const env = { USERPROFILE: "C:\\Users\\test", OPENCLAW_PROFILE: "Default" };
    expect(resolveTaskScriptPath(env)).toBe(
      path.join("C:\\Users\\test", ".openclaw", "gateway.cmd"),
    );
  });

  it("handles case-insensitive 'DEFAULT' profile", () => {
    const env = { USERPROFILE: "C:\\Users\\test", OPENCLAW_PROFILE: "DEFAULT" };
    expect(resolveTaskScriptPath(env)).toBe(
      path.join("C:\\Users\\test", ".openclaw", "gateway.cmd"),
    );
  });

  it("trims whitespace from OPENCLAW_PROFILE", () => {
    const env = { USERPROFILE: "C:\\Users\\test", OPENCLAW_PROFILE: "  myprofile  " };
    expect(resolveTaskScriptPath(env)).toBe(
      path.join("C:\\Users\\test", ".openclaw-myprofile", "gateway.cmd"),
    );
  });

  it("falls back to HOME when USERPROFILE is not set", () => {
    const env = { HOME: "/home/test", OPENCLAW_PROFILE: "default" };
    expect(resolveTaskScriptPath(env)).toBe(path.join("/home/test", ".openclaw", "gateway.cmd"));
  });
});

describe("readScheduledTaskCommand", () => {
  it("parses basic command script", async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-schtasks-test-"));
    try {
      const scriptPath = path.join(tmpDir, ".openclaw", "gateway.cmd");
      await fs.mkdir(path.dirname(scriptPath), { recursive: true });
      await fs.writeFile(
        scriptPath,
        ["@echo off", "node gateway.js --port 18789"].join("\r\n"),
        "utf8",
      );

      const env = { USERPROFILE: tmpDir, OPENCLAW_PROFILE: "default" };
      const result = await readScheduledTaskCommand(env);
      expect(result).toEqual({
        programArguments: ["node", "gateway.js", "--port", "18789"],
      });
    } finally {
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  });

  it("parses script with working directory", async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-schtasks-test-"));
    try {
      const scriptPath = path.join(tmpDir, ".openclaw", "gateway.cmd");
      await fs.mkdir(path.dirname(scriptPath), { recursive: true });
      await fs.writeFile(
        scriptPath,
        ["@echo off", "cd /d C:\\Projects\\openclaw", "node gateway.js"].join("\r\n"),
        "utf8",
      );

      const env = { USERPROFILE: tmpDir, OPENCLAW_PROFILE: "default" };
      const result = await readScheduledTaskCommand(env);
      expect(result).toEqual({
        programArguments: ["node", "gateway.js"],
        workingDirectory: "C:\\Projects\\openclaw",
      });
    } finally {
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  });

  it("parses script with environment variables", async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-schtasks-test-"));
    try {
      const scriptPath = path.join(tmpDir, ".openclaw", "gateway.cmd");
      await fs.mkdir(path.dirname(scriptPath), { recursive: true });
      await fs.writeFile(
        scriptPath,
        ["@echo off", "set NODE_ENV=production", "set PORT=18789", "node gateway.js"].join("\r\n"),
        "utf8",
      );

      const env = { USERPROFILE: tmpDir, OPENCLAW_PROFILE: "default" };
      const result = await readScheduledTaskCommand(env);
      expect(result).toEqual({
        programArguments: ["node", "gateway.js"],
        environment: {
          NODE_ENV: "production",
          PORT: "18789",
        },
      });
    } finally {
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  });

  it("parses script with quoted arguments containing spaces", async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-schtasks-test-"));
    try {
      const scriptPath = path.join(tmpDir, ".openclaw", "gateway.cmd");
      await fs.mkdir(path.dirname(scriptPath), { recursive: true });
      // Use forward slashes which work in Windows cmd and avoid escape parsing issues
      await fs.writeFile(
        scriptPath,
        ["@echo off", '"C:/Program Files/Node/node.exe" gateway.js'].join("\r\n"),
        "utf8",
      );

      const env = { USERPROFILE: tmpDir, OPENCLAW_PROFILE: "default" };
      const result = await readScheduledTaskCommand(env);
      expect(result).toEqual({
        programArguments: ["C:/Program Files/Node/node.exe", "gateway.js"],
      });
    } finally {
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  });

  it("returns null when script does not exist", async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-schtasks-test-"));
    try {
      const env = { USERPROFILE: tmpDir, OPENCLAW_PROFILE: "default" };
      const result = await readScheduledTaskCommand(env);
      expect(result).toBeNull();
    } finally {
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  });

  it("returns null when script has no command", async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-schtasks-test-"));
    try {
      const scriptPath = path.join(tmpDir, ".openclaw", "gateway.cmd");
      await fs.mkdir(path.dirname(scriptPath), { recursive: true });
      await fs.writeFile(
        scriptPath,
        ["@echo off", "rem This is just a comment"].join("\r\n"),
        "utf8",
      );

      const env = { USERPROFILE: tmpDir, OPENCLAW_PROFILE: "default" };
      const result = await readScheduledTaskCommand(env);
      expect(result).toBeNull();
    } finally {
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  });

  it("parses full script with all components", async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-schtasks-test-"));
    try {
      const scriptPath = path.join(tmpDir, ".openclaw", "gateway.cmd");
      await fs.mkdir(path.dirname(scriptPath), { recursive: true });
      await fs.writeFile(
        scriptPath,
        [
          "@echo off",
          "rem OpenClaw Gateway",
          "cd /d C:\\Projects\\openclaw",
          "set NODE_ENV=production",
          "set OPENCLAW_PORT=18789",
          "node gateway.js --verbose",
        ].join("\r\n"),
        "utf8",
      );

      const env = { USERPROFILE: tmpDir, OPENCLAW_PROFILE: "default" };
      const result = await readScheduledTaskCommand(env);
      expect(result).toEqual({
        programArguments: ["node", "gateway.js", "--verbose"],
        workingDirectory: "C:\\Projects\\openclaw",
        environment: {
          NODE_ENV: "production",
          OPENCLAW_PORT: "18789",
        },
      });
    } finally {
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
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
