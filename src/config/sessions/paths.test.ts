import { afterEach, describe, expect, it, vi } from "vitest";

afterEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
  vi.doUnmock("node:fs/promises");
});

describe("ensurePrivateSessionsDir", () => {
  it("rejects when the directory identity changes before chmod", async () => {
    if (process.platform === "win32") {
      return;
    }

    const mkdir = vi.fn(async () => undefined);
    const lstat = vi
      .fn()
      .mockRejectedValueOnce(Object.assign(new Error("missing"), { code: "ENOENT" }))
      .mockResolvedValueOnce({
        isSymbolicLink: () => false,
        isDirectory: () => true,
        dev: 10,
        ino: 20,
      });
    const chmod = vi.fn(async () => undefined);
    const handleChmod = vi.fn(async () => undefined);
    const handleClose = vi.fn(async () => undefined);
    const open = vi.fn(async () => ({
      stat: async () => ({
        isDirectory: () => true,
        dev: 11,
        ino: 21,
      }),
      chmod: handleChmod,
      close: handleClose,
    }));

    vi.doMock("node:fs/promises", async () => {
      const actual = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
      const patched = {
        ...actual,
        mkdir,
        lstat,
        chmod,
        open,
      };
      return { ...patched, default: patched };
    });

    const { ensurePrivateSessionsDir } = await import("./paths.js");

    await expect(ensurePrivateSessionsDir("/tmp/openclaw-race")).rejects.toThrow(
      /changed during permission update/i,
    );
    expect(open).toHaveBeenCalledTimes(1);
    expect(chmod).not.toHaveBeenCalled();
    expect(handleChmod).not.toHaveBeenCalled();
    expect(handleClose).toHaveBeenCalledTimes(1);
  });
});
