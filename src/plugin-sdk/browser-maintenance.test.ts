import { beforeEach, describe, expect, it, vi } from "vitest";

const runCommandWithTimeout = vi.hoisted(() => vi.fn());
const mkdir = vi.hoisted(() => vi.fn());
const access = vi.hoisted(() => vi.fn());
const rename = vi.hoisted(() => vi.fn());

vi.mock("../process/exec.js", () => ({
  runCommandWithTimeout,
}));

vi.mock("node:fs/promises", () => {
  const mocked = { mkdir, access, rename };
  return { ...mocked, default: mocked };
});

vi.mock("node:os", () => ({
  default: {
    homedir: () => "/home/test",
  },
  homedir: () => "/home/test",
}));

describe("browser maintenance", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    runCommandWithTimeout.mockReset();
    mkdir.mockReset();
    access.mockReset();
    rename.mockReset();
    vi.spyOn(Date, "now").mockReturnValue(123);
  });

  it("returns the target path when trash exits successfully", async () => {
    const { movePathToTrash } = await import("./browser-maintenance.js");
    runCommandWithTimeout.mockResolvedValue({
      stdout: "",
      stderr: "",
      code: 0,
      signal: null,
      killed: false,
      termination: "exit",
    });

    await expect(movePathToTrash("/tmp/demo")).resolves.toBe("/tmp/demo");
    expect(mkdir).not.toHaveBeenCalled();
    expect(rename).not.toHaveBeenCalled();
  });

  it("falls back to rename when trash exits non-zero", async () => {
    const { movePathToTrash } = await import("./browser-maintenance.js");
    runCommandWithTimeout.mockResolvedValue({
      stdout: "",
      stderr: "permission denied",
      code: 1,
      signal: null,
      killed: false,
      termination: "exit",
    });
    access.mockRejectedValue(new Error("missing"));

    await expect(movePathToTrash("/tmp/demo")).resolves.toBe("/home/test/.Trash/demo-123");
    expect(mkdir).toHaveBeenCalledWith("/home/test/.Trash", { recursive: true });
    expect(rename).toHaveBeenCalledWith("/tmp/demo", "/home/test/.Trash/demo-123");
  });
});
