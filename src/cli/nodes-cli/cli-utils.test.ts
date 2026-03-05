import { describe, expect, it, vi } from "vitest";

const defaultRuntime = {
  error: vi.fn(),
  exit: vi.fn(),
};

vi.mock("../../runtime.js", () => ({
  defaultRuntime,
}));

const { runNodesCommand } = await import("./cli-utils.js");

describe("runNodesCommand", () => {
  it("hints where to inspect pairing requests", async () => {
    defaultRuntime.error.mockClear();
    defaultRuntime.exit.mockClear();

    await runNodesCommand("status", async () => {
      throw new Error("Pairing required: requestId: 3f3d");
    });

    expect(defaultRuntime.exit).toHaveBeenCalledWith(1);
    expect(defaultRuntime.error).toHaveBeenCalledWith(
      expect.stringContaining("nodes status failed: Error: Pairing required: requestId: 3f3d"),
    );
    expect(defaultRuntime.error).toHaveBeenCalledWith(
      expect.stringContaining("openclaw devices list"),
    );
  });
});
