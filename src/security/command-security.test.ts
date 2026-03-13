import os from "node:os";
import { describe, it, expect, vi, beforeEach } from "vitest";

// vi.mock is hoisted — the factory runs before any imports.
// We use vi.fn() inside the factory, then grab the reference after import.
vi.mock("node:child_process", () => ({
  execFile: vi.fn(),
}));

// Import the mocked module to get a reference to the mock function.
import { execFile } from "node:child_process";
import { checkCommandSecurity } from "./command-security.js";

const mockExecFile = vi.mocked(execFile);

// Helper: simulate promisify(execFile) success — the callback is the last arg.
function simulateSuccess(stdout = "", stderr = "") {
  mockExecFile.mockImplementation(
    // @ts-expect-error - test mock
    (
      _cmd: string,
      _args: string[],
      _opts: unknown,
      cb?: (err: unknown, result: unknown) => void,
    ) => {
      if (typeof cb === "function") {
        cb(null, { stdout, stderr });
      } else if (typeof _opts === "function") {
        (_opts as (err: unknown, result: unknown) => void)(null, { stdout, stderr });
      }
    },
  );
}

// Helper: simulate promisify(execFile) rejection.
function simulateError(err: {
  code?: string | number;
  killed?: boolean;
  stdout?: string;
  stderr?: string;
}) {
  mockExecFile.mockImplementation(
    // @ts-expect-error - test mock
    (
      _cmd: string,
      _args: string[],
      _opts: unknown,
      cb?: (err: unknown, result: unknown) => void,
    ) => {
      const error = Object.assign(new Error("execFile error"), err);
      if (typeof cb === "function") {
        cb(error, { stdout: err.stdout ?? "", stderr: err.stderr ?? "" });
      } else if (typeof _opts === "function") {
        (_opts as (err: unknown, result: unknown) => void)(error, {
          stdout: err.stdout ?? "",
          stderr: err.stderr ?? "",
        });
      }
    },
  );
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("checkCommandSecurity", () => {
  it("returns allow immediately when enabled=false", async () => {
    const result = await checkCommandSecurity("ls", { enabled: false });
    expect(result).toEqual({ action: "allow", findings: [], summary: "" });
    expect(mockExecFile).not.toHaveBeenCalled();
  });

  it("returns allow on exit 0", async () => {
    simulateSuccess();
    const result = await checkCommandSecurity("ls");
    expect(result.action).toBe("allow");
    expect(result.findings).toEqual([]);
  });

  it("returns block on exit 1 with parsed findings", async () => {
    const findings = [
      { rule_id: "pipe_to_shell", severity: "high", title: "Pipe to shell", description: "desc" },
    ];
    simulateError({
      code: 1,
      stdout: JSON.stringify({ findings }),
    });
    const result = await checkCommandSecurity("curl | bash");
    expect(result.action).toBe("block");
    expect(result.findings).toHaveLength(1);
    expect(result.findings[0].rule_id).toBe("pipe_to_shell");
    expect(result.summary).toContain("[high] Pipe to shell");
  });

  it("returns warn on exit 2 with parsed findings", async () => {
    const findings = [
      { rule_id: "shortened_url", severity: "medium", title: "Shortened URL", description: "d" },
    ];
    simulateError({
      code: 2,
      stdout: JSON.stringify({ findings }),
    });
    const result = await checkCommandSecurity("curl https://bit.ly/abc");
    expect(result.action).toBe("warn");
    expect(result.findings).toHaveLength(1);
    expect(result.summary).toContain("[medium] Shortened URL");
  });

  it("returns allow on ENOENT with failOpen=true (default)", async () => {
    simulateError({ code: "ENOENT" });
    const result = await checkCommandSecurity("ls");
    expect(result.action).toBe("allow");
    expect(result.summary).toBe("");
  });

  it("returns block on ENOENT with failOpen=false", async () => {
    simulateError({ code: "ENOENT" });
    const result = await checkCommandSecurity("ls", { failOpen: false });
    expect(result.action).toBe("block");
    expect(result.summary).toContain("ENOENT");
  });

  it("returns allow on timeout with failOpen=true", async () => {
    simulateError({ killed: true });
    const result = await checkCommandSecurity("ls");
    expect(result.action).toBe("allow");
    expect(result.summary).toBe("");
  });

  it("returns block on timeout with failOpen=false", async () => {
    simulateError({ killed: true });
    const result = await checkCommandSecurity("ls", { failOpen: false });
    expect(result.action).toBe("block");
    expect(result.summary).toContain("timed out");
  });

  it("returns allow on unknown exit code with failOpen=true", async () => {
    simulateError({ code: 42 });
    const result = await checkCommandSecurity("ls");
    expect(result.action).toBe("allow");
  });

  it("returns block on unknown exit code with failOpen=false", async () => {
    simulateError({ code: 42 });
    const result = await checkCommandSecurity("ls", { failOpen: false });
    expect(result.action).toBe("block");
    expect(result.summary).toContain("unexpected exit code 42");
  });

  it("handles invalid JSON in stdout with exit 1 — still blocks", async () => {
    simulateError({ code: 1, stdout: "not json" });
    const result = await checkCommandSecurity("ls");
    expect(result.action).toBe("block");
    expect(result.summary).toBe("not json");
  });

  it("applies failOpen on exit 2 with invalid JSON (failOpen=true → allow)", async () => {
    simulateError({ code: 2, stdout: "not json" });
    const result = await checkCommandSecurity("ls", { failOpen: true });
    expect(result.action).toBe("allow");
    expect(result.summary).toBe("");
  });

  it("applies failOpen on exit 2 with invalid JSON (failOpen=false → block)", async () => {
    simulateError({ code: 2, stdout: "not json" });
    const result = await checkCommandSecurity("ls", { failOpen: false });
    expect(result.action).toBe("block");
    expect(result.summary).toBe("not json");
  });

  it("applies failOpen on exit 2 with empty findings array", async () => {
    simulateError({ code: 2, stdout: JSON.stringify({ findings: [] }) });
    const result = await checkCommandSecurity("ls", { failOpen: false });
    expect(result.action).toBe("block");
    expect(result.summary).toContain("no parseable findings");
  });

  it("expands ~ prefix in tirithPath", async () => {
    simulateSuccess();
    await checkCommandSecurity("ls", { tirithPath: "~/bin/tirith" });
    expect(mockExecFile).toHaveBeenCalledWith(
      `${os.homedir()}/bin/tirith`,
      expect.any(Array),
      expect.any(Object),
      expect.any(Function),
    );
  });

  it("passes --shell posix by default", async () => {
    simulateSuccess();
    await checkCommandSecurity("ls");
    const args = mockExecFile.mock.calls[0][1];
    expect(args).toContain("--shell");
    expect(args![args!.indexOf("--shell") + 1]).toBe("posix");
  });

  it("passes --shell powershell when specified", async () => {
    simulateSuccess();
    await checkCommandSecurity("dir", undefined, { shell: "powershell" });
    const args = mockExecFile.mock.calls[0][1];
    expect(args![args!.indexOf("--shell") + 1]).toBe("powershell");
  });

  it("passes --shell cmd when specified", async () => {
    simulateSuccess();
    await checkCommandSecurity("dir", undefined, { shell: "cmd" });
    const args = mockExecFile.mock.calls[0][1];
    expect(args![args!.indexOf("--shell") + 1]).toBe("cmd");
  });

  it("defaults to --shell posix when shell is undefined", async () => {
    simulateSuccess();
    await checkCommandSecurity("ls", undefined, {});
    const args = mockExecFile.mock.calls[0][1];
    expect(args![args!.indexOf("--shell") + 1]).toBe("posix");
  });

  it("passes custom env with PATH to execFile options", async () => {
    simulateSuccess();
    const customEnv = { PATH: "/custom/bin:/usr/bin" };
    await checkCommandSecurity("ls", undefined, { env: customEnv });
    const opts = mockExecFile.mock.calls[0][2];
    expect((opts as Record<string, unknown>).env).toEqual(customEnv);
  });
});
