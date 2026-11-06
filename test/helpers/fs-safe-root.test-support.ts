import path from "node:path";
import { vi } from "vitest";
import * as fsSafe from "../../src/infra/fs-safe.js";

export function observeFsSafeRootMoves(
  rootDir: string,
  onMoved: (destination: string) => void,
): void {
  const realRoot = fsSafe.root;
  vi.spyOn(fsSafe, "root").mockImplementation(async (...args) => {
    const root = await realRoot(...args);
    if (args[0] === rootDir) {
      const move = root.move.bind(root);
      vi.spyOn(root, "move").mockImplementation(async (...moveArgs) => {
        // Native no-clobber publication bypasses node:fs.rename.
        await move(...moveArgs);
        onMoved(path.resolve(root.rootReal, moveArgs[1]));
      });
    }
    return root;
  });
}
