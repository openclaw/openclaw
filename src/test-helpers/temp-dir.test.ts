import { execFileSync } from "node:child_process";
import fsSync from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { resolveRuntimeWorkerArgv, resolveRuntimeWorkerUrl } from "../infra/runtime-worker-url.js";
import { resolveTestNodeExecPath } from "../test-utils/node-process.js";
import { tempDirEntrypoint } from "./temp-dir-runtime.test-support.js";
import { withTempDirSync, withTestDir } from "./temp-dir.js";

const parentRoots = useAutoCleanupTempDirTracker(afterEach);

describe("withTestDir", () => {
  it("keeps the cached async prefix root while another case is active", async () => {
    const parentDir = parentRoots.make("openclaw-temp-dir-helper-test-");
    const firstCanFinish = Promise.withResolvers<void>();

    const first = withTestDir({ prefix: "openclaw-shared-root-", parentDir }, async (dir) => {
      await fs.writeFile(path.join(dir, "first.txt"), "ok");
      await firstCanFinish.promise;
    });

    const firstSettled = first.catch(() => {});
    try {
      await withTestDir({ prefix: "openclaw-shared-root-", parentDir }, async (dir) => {
        await fs.writeFile(path.join(dir, "second.txt"), "ok");
        await expect(fs.readdir(parentDir)).resolves.toHaveLength(1);
      });

      firstCanFinish.resolve();
      await first;

      await expect(fs.readdir(parentDir)).resolves.toStrictEqual([]);
    } finally {
      // Release and join the owned case even when the sibling assertion fails.
      firstCanFinish.resolve();
      await firstSettled;
    }
  });

  it("removes the cached sync prefix root when the case finishes", async () => {
    const parentDir = parentRoots.make("openclaw-temp-dir-helper-test-");

    withTempDirSync({ prefix: "openclaw-leak-check-sync-", parentDir }, (dir) => {
      fsSync.writeFileSync(path.join(dir, "marker.txt"), "ok");
    });

    await expect(fs.readdir(parentDir)).resolves.toStrictEqual([]);
  });
});

describe.skipIf(process.platform === "win32")("private temporary case directories", () => {
  it.each(["async", "sync", "suite"])(
    "admits a private workspace under a group-writable umask (%s)",
    async (kind) => {
      const parentDir = parentRoots.make("openclaw-temp-dir-helper-test-");
      const tempDirUrl = resolveRuntimeWorkerUrl(tempDirEntrypoint);
      const nodeExecutable = resolveTestNodeExecPath();
      // umask is process-wide and cannot be changed in a Vitest worker thread.
      const stdout = execFileSync(
        nodeExecutable,
        [
          ...resolveRuntimeWorkerArgv(tempDirUrl, nodeExecutable).slice(0, -1),
          "--input-type=module",
          "--eval",
          `import fs from "node:fs";
import { tempWorkspaceSync } from "@openclaw/fs-safe/temp";
import { withTestDir, withTempDirSync, createSuiteTempRootTracker } from ${JSON.stringify(tempDirUrl.href)};
process.umask(0o002);
const options = { prefix: "private-case-", parentDir: ${JSON.stringify(parentDir)} };
function exercise(dir) {
  const workspace = tempWorkspaceSync({ rootDir: dir, prefix: "private-workspace-" });
  try {
    workspace.write("marker", "private");
    return workspace.read("marker").toString();
  } finally {
    workspace.cleanup();
  }
}
let result;
if (${JSON.stringify(kind)} === "async") {
  result = await withTestDir({ ...options, subdir: "nested/leaf" }, async (dir) => exercise(dir));
} else if (${JSON.stringify(kind)} === "sync") {
  result = withTempDirSync({ ...options, subdir: "nested/leaf" }, exercise);
} else {
  const tracker = createSuiteTempRootTracker(options);
  await tracker.setup();
  try {
    result = exercise(await tracker.make("nested/case"));
  } finally {
    await tracker.cleanup();
  }
}
console.log(JSON.stringify({ result, remaining: fs.readdirSync(options.parentDir) }));`,
        ],
        {
          cwd: process.cwd(),
          encoding: "utf8",
          timeout: 10_000,
          killSignal: "SIGKILL",
        },
      );
      expect(JSON.parse(stdout)).toEqual({ result: "private", remaining: [] });
    },
  );
});
