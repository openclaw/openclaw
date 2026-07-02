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

  it("quote-wraps args with spaces and metacharacters instead of caret-escaping", () => {
    // Inside double quotes, &|<> are literal in cmd.exe so caret escaping is
    // neither needed nor correct (carets would appear as literal chars).
    const line = buildWindowsCmdExeCommandLine("gemini.cmd", ["--prompt", "install & run"]);
    expect(line).toBe('gemini.cmd --prompt "install & run"');
  });

  it("quote-wraps args with redirection chars when they contain spaces", () => {
    const line = buildWindowsCmdExeCommandLine("gemini.cmd", ["--prompt", "a < b > c"]);
    expect(line).toBe('gemini.cmd --prompt "a < b > c"');
  });

  it("quote-wraps args with pipe when they contain spaces", () => {
    const line = buildWindowsCmdExeCommandLine("gemini.cmd", ["--prompt", "a | b"]);
    expect(line).toBe('gemini.cmd --prompt "a | b"');
  });

  it("caret-escapes ampersand in args without spaces", () => {
    const line = buildWindowsCmdExeCommandLine("gemini.cmd", ["--prompt", "a&b"]);
    expect(line).toBe("gemini.cmd --prompt a^&b");
  });

  it("caret-escapes redirection chars in args without spaces", () => {
    const line = buildWindowsCmdExeCommandLine("gemini.cmd", ["--prompt", "a<b>c"]);
    expect(line).toBe("gemini.cmd --prompt a^<b^>c");
  });

  it("caret-escapes pipe in args without spaces", () => {
    const line = buildWindowsCmdExeCommandLine("gemini.cmd", ["--prompt", "a|b"]);
    expect(line).toBe("gemini.cmd --prompt a^|b");
  });

  it("caret-escapes percent in args without spaces", () => {
    // In cmd.exe /c mode, ^% escapes a single %. Doubling %% is a batch-file
    // convention that doesn't suppress expansion in interactive /c mode.
    const line = buildWindowsCmdExeCommandLine("gemini.cmd", ["--prompt", "100%"]);
    expect(line).toBe("gemini.cmd --prompt 100^%");
  });

  it("preserves literal percent inside quoted args", () => {
    // A lone % not forming a %VAR% pair is literal in cmd.exe, so quoted args
    // pass it through without escaping.
    const line = buildWindowsCmdExeCommandLine("gemini.cmd", ["--prompt", "100% complete"]);
    expect(line).toBe('gemini.cmd --prompt "100% complete"');
  });

  it("caret-escapes multiple metacharacters in args without spaces", () => {
    const line = buildWindowsCmdExeCommandLine("gemini.cmd", ["--prompt", "a&b|c<d>e%f^g"]);
    expect(line).toBe("gemini.cmd --prompt a^&b^|c^<d^>e^%f^^g");
  });

  it("preserves safe prompt text unchanged", () => {
    const line = buildWindowsCmdExeCommandLine("gemini.cmd", [
      "--prompt",
      "What is the capital of France?",
    ]);
    expect(line).toBe('gemini.cmd --prompt "What is the capital of France?"');
  });

  it("escapes embedded double quotes inside args", () => {
    const line = buildWindowsCmdExeCommandLine("gemini.cmd", ["--prompt", 'he said "hello"']);
    expect(line).toBe('gemini.cmd --prompt "he said ""hello"""');
  });

  it("still throws on newline characters", () => {
    expect(() => buildWindowsCmdExeCommandLine("gemini.cmd", ["line1\nline2"])).toThrow(
      "Newline characters",
    );
  });

  it("still throws on carriage return characters", () => {
    expect(() => buildWindowsCmdExeCommandLine("gemini.cmd", ["line1\rline2"])).toThrow(
      "Newline characters",
    );
  });
});
