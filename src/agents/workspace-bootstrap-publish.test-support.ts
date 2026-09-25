import fs from "node:fs/promises";
import path from "node:path";
import { expect, vi } from "vitest";
import * as fsSafe from "../infra/fs-safe.js";

type StageWrite = (
  replacement?: Parameters<fsSafe.Root["write"]>[1],
) => ReturnType<fsSafe.Root["write"]>;

/** Intercept real bootstrap staging writes without replacing their capability or options. */
export function interceptBootstrapStageWrites(
  intercept: (filePath: string, write: StageWrite) => ReturnType<fsSafe.Root["write"]>,
): () => void {
  const realRoot = fsSafe.root;
  const restoreWrites: (() => void)[] = [];
  const rootSpy = vi.spyOn(fsSafe, "root").mockImplementation(async (...args) => {
    const root = await realRoot(...args);
    const write = root.write.bind(root);
    const writeSpy = vi
      .spyOn(root, "write")
      .mockImplementation(async (relativePath, data, options) => {
        const target = path.join(root.rootReal, relativePath);
        if (!path.basename(path.dirname(target)).startsWith("openclaw-bootstrap-")) {
          return await write(relativePath, data, options);
        }
        return await intercept(
          target,
          async (replacement = data) => await write(relativePath, replacement, options),
        );
      });
    restoreWrites.push(() => writeSpy.mockRestore());
    return root;
  });
  return () => {
    rootSpy.mockRestore();
    for (const restore of restoreWrites) {
      restore();
    }
  };
}

/** Fail after a real partial stage write, leaving publication and cleanup with their owner. */
export async function injectPartialPublicationFailure(dir: string, fileName: string) {
  const resolvedDir = await fs.realpath(dir);
  let injected = false;
  const restore = interceptBootstrapStageWrites(async (target, write) => {
    if (
      !injected &&
      path.dirname(path.dirname(target)) === resolvedDir &&
      path.basename(target) === fileName
    ) {
      injected = true;
      await write("# PARTIAL\n");
      throw Object.assign(new Error("ENOSPC"), { code: "ENOSPC" });
    }
    return await write();
  });
  return { restore, assertInjected: () => expect(injected).toBe(true) };
}
