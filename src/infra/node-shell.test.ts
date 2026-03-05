import { describe, expect, it } from "vitest";
import { buildNodeShellCommand } from "./node-shell.js";

describe("buildNodeShellCommand", () => {
  describe("non-Windows platforms", () => {
    it("wraps in /bin/sh -lc on linux", () => {
      expect(buildNodeShellCommand("ls -la", "linux")).toEqual(["/bin/sh", "-lc", "ls -la"]);
    });

    it("wraps in /bin/sh -lc on darwin", () => {
      expect(buildNodeShellCommand("echo hello", "darwin")).toEqual([
        "/bin/sh",
        "-lc",
        "echo hello",
      ]);
    });

    it("defaults to /bin/sh -lc when platform is absent", () => {
      expect(buildNodeShellCommand("cat file.txt")).toEqual(["/bin/sh", "-lc", "cat file.txt"]);
    });
  });

  describe("Windows non-PowerShell commands", () => {
    it("wraps cmd commands in cmd.exe /d /s /c", () => {
      expect(buildNodeShellCommand("dir /b", "win32")).toEqual([
        "cmd.exe",
        "/d",
        "/s",
        "/c",
        "dir /b",
      ]);
    });

    it("wraps arbitrary commands in cmd.exe on windows", () => {
      expect(buildNodeShellCommand("ipconfig /all", "win32")).toEqual([
        "cmd.exe",
        "/d",
        "/s",
        "/c",
        "ipconfig /all",
      ]);
    });
  });

  describe("Windows PowerShell commands — bypass cmd.exe (refs #35807)", () => {
    it("invokes powershell.exe directly without cmd.exe wrapper", () => {
      const result = buildNodeShellCommand("powershell -Command Get-Process", "win32");
      expect(result[0]).not.toBe("cmd.exe");
      expect(result[0]?.toLowerCase()).toBe("powershell");
    });

    it("preserves -Command flag and inline script as separate argv tokens", () => {
      const result = buildNodeShellCommand(
        'powershell -NoProfile -Command "Get-Process | Where-Object {$_.CPU -gt 10}"',
        "win32",
      );
      expect(result).toEqual([
        "powershell",
        "-NoProfile",
        "-Command",
        "Get-Process | Where-Object {$_.CPU -gt 10}",
      ]);
    });

    it("handles pwsh (PowerShell 7) the same way", () => {
      const result = buildNodeShellCommand('pwsh -Command "Get-ChildItem"', "win32");
      expect(result[0]).toBe("pwsh");
      expect(result).not.toContain("cmd.exe");
    });

    it("handles powershell.exe with .exe extension", () => {
      const result = buildNodeShellCommand("powershell.exe -File script.ps1", "win32");
      expect(result[0]).toBe("powershell.exe");
      expect(result).toEqual(["powershell.exe", "-File", "script.ps1"]);
    });

    it("handles pwsh.exe with .exe extension", () => {
      const result = buildNodeShellCommand('pwsh.exe -NonInteractive -Command "1+1"', "win32");
      expect(result[0]).toBe("pwsh.exe");
    });

    it("is case-insensitive for PowerShell detection", () => {
      const result = buildNodeShellCommand('PowerShell -Command "Get-Date"', "win32");
      expect(result[0]).toBe("PowerShell");
      expect(result).not.toContain("cmd.exe");
    });

    it("preserves pipeline variables inside quoted -Command arg", () => {
      // Regression: $ should not be mangled when passed through PowerShell directly
      const script = "Get-Process | ForEach-Object { $_.Name }";
      const result = buildNodeShellCommand(`powershell -Command "${script}"`, "win32");
      expect(result).toContain(script);
      expect(result).not.toContain("cmd.exe");
    });

    it("preserves -f string format operator (single-quoted PowerShell string)", () => {
      // PowerShell typically uses single quotes for strings with -f; double-quoted
      // wrapping around the -Command value is handled correctly by the tokenizer.
      const script = "'Result: {0}' -f (1 + 2)";
      const result = buildNodeShellCommand(`powershell -Command "${script}"`, "win32");
      expect(result).toContain(script);
    });
  });
});
