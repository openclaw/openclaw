import { beforeEach, describe, expect, it, vi } from "vitest";

const runCommandWithTimeoutMock = vi.hoisted(() => vi.fn());
const isWSL2SyncMock = vi.hoisted(() => vi.fn(() => false));

vi.mock("../process/exec.js", () => ({
  runCommandWithTimeout: (...args: unknown[]) => runCommandWithTimeoutMock(...args),
}));

vi.mock("./wsl.js", () => ({
  isWSL2Sync: isWSL2SyncMock,
}));

const { copyToClipboard } = await import("./clipboard.js");
const success = { code: 0, killed: false };
const killed = { code: 0, killed: true };
const missing = new Error("clipboard command missing");
const options = (input: string) => ({ timeoutMs: 3000, input });

describe("copyToClipboard", () => {
  beforeEach(() => {
    runCommandWithTimeoutMock.mockReset();
    isWSL2SyncMock.mockReturnValue(false);
  });

  it("returns true on the first successful clipboard command", async () => {
    runCommandWithTimeoutMock.mockResolvedValueOnce(success);

    await expect(copyToClipboard("hello")).resolves.toBe(true);
    expect(runCommandWithTimeoutMock).toHaveBeenCalledWith(["pbcopy"], options("hello"));
    expect(runCommandWithTimeoutMock).toHaveBeenCalledTimes(1);
  });

  it("uses a startup-free WSL2 shell bridge for clip.exe without putting the value in argv", async () => {
    isWSL2SyncMock.mockReturnValue(true);
    runCommandWithTimeoutMock.mockResolvedValueOnce(success);

    const tokenUrl = "http://127.0.0.1:18789/#token=secret-token";
    await expect(copyToClipboard(tokenUrl)).resolves.toBe(true);

    expect(runCommandWithTimeoutMock).toHaveBeenCalledWith(
      ["/bin/sh", "-c", "exec /mnt/c/Windows/System32/clip.exe"],
      options(tokenUrl),
    );
    const invokedArgv = runCommandWithTimeoutMock.mock.calls[0]?.[0] as string[];
    expect(invokedArgv.join("\0")).not.toContain("secret-token");
    expect(runCommandWithTimeoutMock).toHaveBeenCalledTimes(1);
  });

  it("does not prepend the WSL2 bridge outside WSL2", async () => {
    runCommandWithTimeoutMock
      .mockRejectedValueOnce(missing)
      .mockResolvedValueOnce(killed)
      .mockRejectedValueOnce(missing)
      .mockResolvedValueOnce(success);

    await expect(copyToClipboard("hello")).resolves.toBe(true);
    expect(runCommandWithTimeoutMock.mock.calls.map((call) => call[0])).toEqual([
      ["pbcopy"],
      ["xclip", "-selection", "clipboard"],
      ["wl-copy"],
      ["clip.exe"],
    ]);
  });

  it("passes PowerShell clipboard text as UTF-8 base64 on stdin", async () => {
    for (let i = 0; i < 4; i++) {
      runCommandWithTimeoutMock.mockRejectedValueOnce(missing);
    }
    runCommandWithTimeoutMock.mockResolvedValueOnce(success);

    const value = "\u4f60\u597d\u4e16\u754c \ud83c\udf89 caf\u00e9";
    await expect(copyToClipboard(value)).resolves.toBe(true);

    const [argv, callOptions] = runCommandWithTimeoutMock.mock.calls[4] as [
      string[],
      { timeoutMs: number; input: string },
    ];
    expect(argv.slice(0, 4)).toEqual(["powershell", "-NoProfile", "-NonInteractive", "-Command"]);
    expect(argv.join("\0")).not.toContain(value);
    expect(callOptions).toEqual(options(Buffer.from(value, "utf8").toString("base64")));
  });

  it("returns false when every clipboard backend fails or is killed", async () => {
    runCommandWithTimeoutMock
      .mockResolvedValueOnce(killed)
      .mockRejectedValueOnce(missing)
      .mockResolvedValueOnce({ code: 1, killed: false })
      .mockRejectedValueOnce(missing)
      .mockResolvedValueOnce({ code: 2, killed: false });

    await expect(copyToClipboard("hello")).resolves.toBe(false);
    expect(runCommandWithTimeoutMock).toHaveBeenCalledTimes(5);
  });
});
