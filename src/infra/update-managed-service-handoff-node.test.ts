import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import * as runtimePaths from "../daemon/runtime-paths.js";
import { resolveManagedHandoffNodeExecutable } from "./update-managed-service-handoff-node.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

describe("managed handoff Node selection", () => {
  it.runIf(process.platform !== "win32")(
    "skips an unusable PATH Node and launches a compatible replacement",
    async () => {
      const originalExecPath = process.execPath;
      const root = tempDirs.make("openclaw-handoff-node-probe-");
      const badDir = path.join(root, "bad");
      const goodDir = path.join(root, "good");
      await fs.mkdir(badDir);
      await fs.mkdir(goodDir);
      await fs.writeFile(path.join(badDir, "node"), "#!/bin/sh\nexit 1\n", { mode: 0o755 });
      const replacement = path.join(goodDir, "node");
      await fs.symlink(originalExecPath, replacement);
      const removed = path.join(root, "removed-node");
      await fs.symlink(originalExecPath, removed);
      await fs.unlink(removed);
      const systemProbe = vi.spyOn(runtimePaths, "resolveSystemNodeInfo").mockResolvedValue(null);
      process.execPath = removed;
      try {
        expect(
          await resolveManagedHandoffNodeExecutable({
            PATH: `${badDir}${path.delimiter}${goodDir}`,
          }),
        ).toBe(replacement);
      } finally {
        process.execPath = originalExecPath;
        systemProbe.mockRestore();
      }
    },
  );
});
