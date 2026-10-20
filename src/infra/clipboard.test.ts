import { beforeEach, expect, it, vi } from "vitest";

const runCommandWithTimeoutMock = vi.hoisted(() => vi.fn());
const isWSL2SyncMock = vi.hoisted(() => vi.fn(() => false));

vi.mock("../process/exec.js", () => ({ runCommandWithTimeout: runCommandWithTimeoutMock }));

vi.mock("./wsl.js", () => ({ isWSL2Sync: isWSL2SyncMock }));

const { copyToClipboard } = await import("./clipboard.js");
const success = { code: 0, killed: false };
const killed = { code: 0, killed: true };
const missing = new Error("clipboard command missing");
const options = (input: string) => ({ timeoutMs: 3000, input });
function queue(...results: (Error | typeof success)[]) {
  for (const result of results) {
    if (result instanceof Error) {
      runCommandWithTimeoutMock.mockRejectedValueOnce(result);
    } else {
      runCommandWithTimeoutMock.mockResolvedValueOnce(result);
    }
  }
}

beforeEach(() => {
  runCommandWithTimeoutMock.mockReset();
  isWSL2SyncMock.mockReturnValue(false);
});

it.each([
  [false, ["pbcopy"]],
  [true, ["/bin/sh", "-c", "exec /mnt/c/Windows/System32/clip.exe"]],
] as const)("uses the first backend with stdin-only text (WSL2: %s)", async (wsl, argv) => {
  isWSL2SyncMock.mockReturnValue(wsl);
  queue(success);

  const tokenUrl = "http://127.0.0.1:18789/#token=secret-token";
  await expect(copyToClipboard(tokenUrl)).resolves.toBe(true);

  expect(runCommandWithTimeoutMock).toHaveBeenCalledWith(argv, options(tokenUrl));
  expect(runCommandWithTimeoutMock).toHaveBeenCalledTimes(1);
});

it("does not prepend the WSL2 bridge outside WSL2", async () => {
  queue(missing, killed, missing, success);

  await expect(copyToClipboard("hello")).resolves.toBe(true);
  expect(runCommandWithTimeoutMock.mock.calls.map((call) => call[0])).toEqual([
    ["pbcopy"],
    ["xclip", "-selection", "clipboard"],
    ["wl-copy"],
    ["clip.exe"],
  ]);
});

it("passes PowerShell clipboard text as UTF-8 base64 on stdin", async () => {
  queue(missing, missing, missing, missing, success);

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
  queue(killed, missing, { code: 1, killed: false }, missing, { code: 2, killed: false });

  await expect(copyToClipboard("hello")).resolves.toBe(false);
  expect(runCommandWithTimeoutMock).toHaveBeenCalledTimes(5);
});
