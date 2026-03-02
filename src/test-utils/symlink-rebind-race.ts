import fs from "node:fs/promises";
import { vi } from "vitest";

export async function withRealpathSymlinkRebindRace<T>(params: {
  shouldFlip: (realpathInput: string) => boolean;
  symlinkPath: string;
  symlinkTarget: string;
  timing?: "before-realpath" | "after-realpath";
  run: () => Promise<T>;
}): Promise<T> {
  const realRealpath = fs.realpath.bind(fs);
  let flipped = false;
  const realpathSpy = vi
    .spyOn(fs, "realpath")
    .mockImplementation(async (...args: Parameters<typeof fs.realpath>) => {
      const filePath = String(args[0]);
      if (!flipped && params.shouldFlip(filePath)) {
        flipped = true;
        if (params.timing !== "after-realpath") {
          await fs.rm(params.symlinkPath, { recursive: true, force: true });
          await fs.symlink(params.symlinkTarget, params.symlinkPath);
          return await realRealpath(...args);
        }
        const resolved = await realRealpath(...args);
        await fs.rm(params.symlinkPath, { recursive: true, force: true });
        await fs.symlink(params.symlinkTarget, params.symlinkPath);
        return resolved;
      }
      return await realRealpath(...args);
    });
  try {
    return await params.run();
  } finally {
    realpathSpy.mockRestore();
  }
}
