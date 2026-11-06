import path from "node:path";
import { beforeEach, expect, it, vi } from "vitest";

const spawnSyncMock = vi.hoisted(() => vi.fn());

vi.mock("node:child_process", async (original) => ({
  ...(await original<typeof import("node:child_process")>()),
  spawnSync: spawnSyncMock,
}));

beforeEach(() => {
  vi.resetModules();
  spawnSyncMock.mockReset();
  vi.spyOn(process, "platform", "get").mockReturnValue("win32");
  // Only the canonical install-root path exists; a bare name cannot be resolved from
  // PATH, which is what a service or trimmed-PATH launcher looks like.
  spawnSyncMock.mockImplementation((command: string) => {
    if (!path.win32.isAbsolute(command)) {
      throw new Error(`spawnSync ${command} ENOENT`);
    }
    return { stdout: "1252\r\n", stderr: "", status: 0 };
  });
});

it("probes the system encoding through the install-root path, not a bare name", async () => {
  const { createWindowsTextFileDecoder } = await import("./windows-encoding.js");
  const decoder = createWindowsTextFileDecoder({ prefix: Buffer.from([0xe9, 0x0a]) });
  expect(decoder.encoding).toBe("windows-1252");
  expect(decoder.decode(Buffer.from([0xe9, 0x0a]))).toBe("é\n");
  const probed = spawnSyncMock.mock.calls.map(([command]) => String(command));
  expect(probed.some((command) => path.win32.isAbsolute(command))).toBe(true);
});
