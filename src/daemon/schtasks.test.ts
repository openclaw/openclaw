import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  buildTaskScript,
  parseSchtasksQuery,
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

  it("falls back to HOME when USERPROFILE is not set", () => {
    const env = { HOME: "/home/test", OPENCLAW_PROFILE: "default" };
    expect(resolveTaskScriptPath(env)).toBe(path.join("/home/test", ".openclaw", "gateway.cmd"));
  });
});

describe("buildTaskScript", () => {
  it("strips CRLF from environment variable values to prevent command injection", () => {
    const script = buildTaskScript({
      programArguments: ["node", "gateway.js"],
      environment: {
        SAFE_VAR: "hello",
        MALICIOUS_VAR: "foo\r\nnet user attacker P@ss /add",
      },
    });
    const lines = script.split("\r\n");
    expect(lines.find((line) => line.trim() === "net user attacker P@ss /add")).toBeUndefined();
    expect(lines).toContain("set MALICIOUS_VAR=foonet user attacker P@ss /add");
    expect(lines).toContain("set SAFE_VAR=hello");
  });

  it("strips LF-only injection from environment variable values", () => {
    const script = buildTaskScript({
      programArguments: ["node", "gateway.js"],
      environment: {
        INJECT: "val\ncalc.exe",
      },
    });
    const lines = script.split("\r\n");
    expect(lines.find((line) => line === "calc.exe")).toBeUndefined();
    expect(lines).toContain("set INJECT=valcalc.exe");
  });

  it("strips CRLF from environment variable keys", () => {
    const script = buildTaskScript({
      programArguments: ["node", "gateway.js"],
      environment: {
        "BAD\r\nKEY": "value",
      },
    });
    const lines = script.split("\r\n");
    expect(lines).toContain("set BADKEY=value");
  });
});

describe("readScheduledTaskCommand", () => {
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
  it("parses command with Windows backslash paths", async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-schtasks-test-"));
    try {
      const scriptPath = path.join(tmpDir, ".openclaw", "gateway.cmd");
      await fs.mkdir(path.dirname(scriptPath), { recursive: true });
      await fs.writeFile(
        scriptPath,
        [
          "@echo off",
          '"C:\\Program Files\\nodejs\\node.exe" C:\\Users\\test\\AppData\\Roaming\\npm\\node_modules\\openclaw\\dist\\index.js gateway --port 18789',
        ].join("\r\n"),
        "utf8",
      );

      const env = { USERPROFILE: tmpDir, OPENCLAW_PROFILE: "default" };
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
    } finally {
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  });

  it("preserves UNC paths in command arguments", async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-schtasks-test-"));
    try {
      const scriptPath = path.join(tmpDir, ".openclaw", "gateway.cmd");
      await fs.mkdir(path.dirname(scriptPath), { recursive: true });
      await fs.writeFile(
        scriptPath,
        [
          "@echo off",
          '"\\\\fileserver\\OpenClaw Share\\node.exe" "\\\\fileserver\\OpenClaw Share\\dist\\index.js" gateway --port 18789',
        ].join("\r\n"),
        "utf8",
      );

      const env = { USERPROFILE: tmpDir, OPENCLAW_PROFILE: "default" };
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
    } finally {
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  });
});
