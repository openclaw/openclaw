import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { runtimeProcessEntrypoints } from "../../infra/runtime-process-entrypoints.js";
import {
  resolveRuntimeWorkerArgv,
  resolveRuntimeWorkerUrl,
} from "../../infra/runtime-worker-url.js";
import { runCommandWithTimeout } from "../../process/exec.js";

const directories = useAutoCleanupTempDirTracker(afterEach);

it("removes only the retired checkout and completes when it is already absent", async () => {
  const root = directories.make("retired-worktree-cleanup-");
  const retired = path.join(root, ".openclaw-removing-test");
  const preserved = path.join(root, "active.txt");
  await fs.mkdir(path.join(retired, "nested"), { recursive: true });
  await fs.writeFile(path.join(retired, "nested", "file.txt"), "retired bytes");
  await fs.writeFile(preserved, "active bytes");
  const argv = [
    process.execPath,
    ...resolveRuntimeWorkerArgv(
      resolveRuntimeWorkerUrl(runtimeProcessEntrypoints.retiredWorktreeCleanup),
    ),
    retired,
  ];
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const result = await runCommandWithTimeout(argv, { timeoutMs: 10_000 });
    expect(result).toMatchObject({ code: 0, termination: "exit" });
    await expect(fs.stat(retired)).rejects.toMatchObject({ code: "ENOENT" });
    expect(await fs.readFile(preserved, "utf8")).toBe("active bytes");
  }
});
