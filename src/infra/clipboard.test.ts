import { beforeEach, describe, expect, it, vi } from "vitest";

const runCommandWithTimeoutMock = vi.hoisted(() => vi.fn());

vi.mock("../process/exec.js", () => ({
  runCommandWithTimeout: (...args: unknown[]) => runCommandWithTimeoutMock(...args),
}));

const { copyToClipboard } = await import("./clipboard.js");

describe("copyToClipboard", () => {
  beforeEach(() => {
    runCommandWithTimeoutMock.mockReset();
  });

  it("returns true on the first successful clipboard command", async () => {
    runCommandWithTimeoutMock.mockResolvedValueOnce({ code: 0, killed: false });

    await expect(copyToClipboard("hello")).resolves.toBe(true);
    expect(runCommandWithTimeoutMock).toHaveBeenCalledWith(["pbcopy"], {
      timeoutMs: 3000,
      input: "hello",
    });
    expect(runCommandWithTimeoutMock).toHaveBeenCalledTimes(1);
  });

  it("falls through failed attempts until a later command succeeds", async () => {
    runCommandWithTimeoutMock
      .mockRejectedValueOnce(new Error("missing pbcopy"))
      .mockResolvedValueOnce({ code: 1, killed: false })
      .mockResolvedValueOnce({ code: 0, killed: false });

    await expect(copyToClipboard("hello")).resolves.toBe(true);
    expect(runCommandWithTimeoutMock.mock.calls.map((call) => call[0])).toEqual([
      ["pbcopy"],
      ["xclip", "-selection", "clipboard"],
      ["wl-copy"],
    ]);
  });

  it("returns false when every clipboard backend fails or is killed", async () => {
    runCommandWithTimeoutMock
      .mockResolvedValueOnce({ code: 0, killed: true })
      .mockRejectedValueOnce(new Error("missing xclip"))
      .mockResolvedValueOnce({ code: 1, killed: false })
      .mockRejectedValueOnce(new Error("missing clip.exe"))
      .mockResolvedValueOnce({ code: 2, killed: false });

    await expect(copyToClipboard("hello")).resolves.toBe(false);
    expect(runCommandWithTimeoutMock).toHaveBeenCalledTimes(5);
  });
});
