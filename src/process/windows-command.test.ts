// Windows command tests cover command quoting and shell resolution on Windows.
import { describe, expect, it } from "vitest";
import { buildWindowsCmdExeCommandLine, resolveWindowsCommandShim } from "./windows-command.js";

describe("resolveWindowsCommandShim", () => {
  it("leaves commands unchanged outside Windows", () => {
    expect(
      resolveWindowsCommandShim({
        command: "pnpm",
        cmdCommands: ["pnpm"],
        platform: "linux",
      }),
    ).toBe("pnpm");
  });

  it("appends .cmd for configured Windows shims", () => {
    expect(
      resolveWindowsCommandShim({
        command: "pnpm",
        cmdCommands: ["corepack", "pnpm", "yarn"],
        platform: "win32",
      }),
    ).toBe("pnpm.cmd");
  });

  it("appends .cmd for corepack on Windows", () => {
    expect(
      resolveWindowsCommandShim({
        command: "corepack",
        cmdCommands: ["corepack", "pnpm", "yarn"],
        platform: "win32",
      }),
    ).toBe("corepack.cmd");
  });

  it("keeps explicit extensions on Windows", () => {
    expect(
      resolveWindowsCommandShim({
        command: "npm.cmd",
        cmdCommands: ["npm", "npx"],
        platform: "win32",
      }),
    ).toBe("npm.cmd");
  });
});

describe("buildWindowsCmdExeCommandLine", () => {
  it("builds a simple command line", () => {
    expect(buildWindowsCmdExeCommandLine("gemini.cmd", ["--version"])).toBe("gemini.cmd --version");
  });

  it("quote-wraps args containing spaces", () => {
    expect(buildWindowsCmdExeCommandLine("gemini.cmd", ["Hello World"])).toBe(
      'gemini.cmd "Hello World"',
    );
  });

  it("escapes ampersand with caret", () => {
    const line = buildWindowsCmdExeCommandLine("gemini.cmd", ["--prompt", "install & run"]);
    expect(line).toContain("^&");
    expect(line).not.toContain("Unsafe");
  });

  it("escapes redirection chars with caret", () => {
    const line = buildWindowsCmdExeCommandLine("gemini.cmd", ["--prompt", "a < b > c"]);
    expect(line).toContain("^<");
    expect(line).toContain("^>");
  });

  it("escapes pipe with caret", () => {
    const line = buildWindowsCmdExeCommandLine("gemini.cmd", ["--prompt", "a | b"]);
    expect(line).toContain("^|");
  });

  it("doubles percent signs to suppress variable expansion", () => {
    const line = buildWindowsCmdExeCommandLine("gemini.cmd", ["--prompt", "100%"]);
    expect(line).toContain("%%");
  });

  it("preserves safe prompt text unchanged", () => {
    const line = buildWindowsCmdExeCommandLine("gemini.cmd", [
      "--prompt",
      "What is the capital of France?",
    ]);
    expect(line).toBe('gemini.cmd --prompt "What is the capital of France?"');
  });

  it("still throws on newline characters", () => {
    expect(() => buildWindowsCmdExeCommandLine("gemini.cmd", ["line1\nline2"])).toThrow(
      "Newline characters",
    );
  });
});
