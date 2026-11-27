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

it("keeps the cached async prefix root while another case is active", async () => {
  const parentDir = parentRoots.make("openclaw-temp-dir-helper-test-");
  const options = { prefix: "openclaw-shared-root-", parentDir };
  const firstCanFinish = Promise.withResolvers<void>();
  const first = withTestDir(options, async () => firstCanFinish.promise);
  const firstSettled = first.catch(() => {});
  try {
    await withTestDir(options, async () => {
      await expect(fs.readdir(parentDir)).resolves.toHaveLength(1);
    });
  } finally {
    // Release and join the owned case even when the sibling assertion fails.
    firstCanFinish.resolve();
    await firstSettled;
  }
  await first;
  await expect(fs.readdir(parentDir)).resolves.toStrictEqual([]);
});

it("removes the cached sync prefix root when the case finishes", async () => {
  const parentDir = parentRoots.make("openclaw-temp-dir-helper-test-");

  withTempDirSync({ prefix: "openclaw-leak-check-sync-", parentDir }, (dir) => {
    fsSync.writeFileSync(path.join(dir, "marker.txt"), "ok");
  });

  await expect(fs.readdir(parentDir)).resolves.toStrictEqual([]);
});

describe.skipIf(process.platform === "win32")("private temporary case directories", () => {
  it.each([
    ["async", "result = await withTestDir(options, async (dir) => exercise(dir));"],
    ["sync", "result = withTempDirSync(options, exercise);"],
    [
      "suite",
      `const tracker = createSuiteTempRootTracker(options);
await tracker.setup();
try {
  result = exercise(await tracker.make("nested/case"));
} finally {
  await tracker.cleanup();
}`,
    ],
  ])("admits a private workspace under a group-writable umask (%s)", (_kind, run) => {
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
import { withTempWorkspaceSync } from "@openclaw/fs-safe/temp";
import { withTestDir, withTempDirSync, createSuiteTempRootTracker } from ${JSON.stringify(tempDirUrl.href)};
process.umask(0o002);
const options = { prefix: "private-case-", parentDir: ${JSON.stringify(parentDir)}, subdir: "nested/leaf" };
const exercise = (dir) => withTempWorkspaceSync({ rootDir: dir, prefix: "private-workspace-" }, (workspace) => {
  workspace.write("marker", "private");
  return workspace.read("marker").toString();
});
let result;
${run}
console.log(JSON.stringify({ result, remaining: fs.readdirSync(options.parentDir) }));`,
      ],
      { cwd: process.cwd(), encoding: "utf8", timeout: 10_000, killSignal: "SIGKILL" },
    );
    expect(JSON.parse(stdout)).toEqual({ result: "private", remaining: [] });
  });
});
