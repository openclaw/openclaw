import { exec } from "child_process";
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("child_process", () => ({
  exec: vi.fn(),
}));

const execMock = vi.mocked(exec) as unknown as ReturnType<typeof vi.fn>;

function mockExecSuccess(stdout: string, stderr: string) {
  execMock.mockImplementation(
    (_cmd: string, _opts: unknown, cb: (err: null, result: Record<string, unknown>) => void) => {
      cb(null, { stdout, stderr });
    },
  );
}

function mockExecError(error: Error & { stdout?: string; stderr?: string }) {
  execMock.mockImplementation(
    (
      _cmd: string,
      _opts: unknown,
      cb: (err: Record<string, unknown>, result: Record<string, unknown>) => void,
    ) => {
      cb(
        { message: error.message, stdout: error.stdout, stderr: error.stderr },
        { stdout: error.stdout ?? "", stderr: error.stderr ?? "" },
      );
    },
  );
}

describe("shell", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns stdout on success", async () => {
    mockExecSuccess("hello", "");
    const { shellTool } = await import("./shell.js");
    const result = (await shellTool.execute("call1", { command: "echo hello" })) as {
      data?: { stdout: string; stderr: string; success: boolean };
    };
    expect(result.data?.stdout).toBe("hello");
    expect(result.data?.success).toBe(true);
  });

  it("returns error result if exec fails", async () => {
    const err = Object.assign(new Error("boom"), {
      stdout: "partial",
      stderr: "something went wrong",
    });
    mockExecError(err);
    const { shellTool } = await import("./shell.js");
    const result = (await shellTool.execute("call2", { command: "bad" })) as {
      data?: { success: boolean };
    };
    expect(result.data?.success).toBe(false);
  });
});
