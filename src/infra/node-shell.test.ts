import { describe, it, expect } from "vitest";
import { buildNodeShellCommand } from "./node-shell.js";

describe("buildNodeShellCommand", () => {
  it("returns sh command for unix platforms", () => {
    const result = buildNodeShellCommand("echo hello", "linux");
    expect(result).toEqual(["/bin/sh", "-lc", "echo hello"]);
  });

  it("returns sh command for darwin", () => {
    const result = buildNodeShellCommand("echo hello", "darwin");
    expect(result).toEqual(["/bin/sh", "-lc", "echo hello"]);
  });

  it("returns sh command for empty string", () => {
    const result = buildNodeShellCommand("echo hello", "");
    expect(result).toEqual(["/bin/sh", "-lc", "echo hello"]);
  });

  it("returns sh command for null", () => {
    const result = buildNodeShellCommand("echo hello", null);
    expect(result).toEqual(["/bin/sh", "-lc", "echo hello"]);
  });

  it("returns sh command for undefined", () => {
    const result = buildNodeShellCommand("echo hello", undefined);
    expect(result).toEqual(["/bin/sh", "-lc", "echo hello"]);
  });

  it("returns cmd command for windows", () => {
    const result = buildNodeShellCommand("echo hello", "win32");
    expect(result).toEqual(["cmd.exe", "/d", "/s", "/c", "echo hello"]);
  });

  it("returns cmd command for windows platform", () => {
    const result = buildNodeShellCommand("echo hello", "windows");
    expect(result).toEqual(["cmd.exe", "/d", "/s", "/c", "echo hello"]);
  });

  it("returns cmd command for win platform", () => {
    const result = buildNodeShellCommand("echo hello", "win");
    expect(result).toEqual(["cmd.exe", "/d", "/s", "/c", "echo hello"]);
  });

  it("handles command with spaces", () => {
    const result = buildNodeShellCommand("ls -la /tmp", "linux");
    expect(result).toEqual(["/bin/sh", "-lc", "ls -la /tmp"]);
  });

  it("trims whitespace from platform", () => {
    const result = buildNodeShellCommand("echo hello", "  linux  ");
    expect(result).toEqual(["/bin/sh", "-lc", "echo hello"]);
  });

  it("case insensitive platform matching", () => {
    const result = buildNodeShellCommand("echo hello", "LINUX");
    expect(result).toEqual(["/bin/sh", "-lc", "echo hello"]);
  });

  it("windows prefix matching is case insensitive", () => {
    const result = buildNodeShellCommand("echo hello", "WIN32");
    expect(result).toEqual(["cmd.exe", "/d", "/s", "/c", "echo hello"]);
  });
});
