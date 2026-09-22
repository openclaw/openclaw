// Temporary directory helper tests cover temp directory cleanup behavior.
import fsSync from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { execNodeEvalSync } from "../test-utils/node-process.js";
import { withTempDirSync, withTestDir } from "./temp-dir.js";

const parentRoots: string[] = [];

async function makeParentRoot(): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-temp-dir-helper-test-"));
  parentRoots.push(root);
  return root;
}

afterEach(async () => {
  await Promise.all(
    parentRoots.splice(0).map((root) =>
      fs.rm(root, {
        recursive: true,
        force: true,
        maxRetries: 20,
        retryDelay: 25,
      }),
    ),
  );
});

describe("withTestDir", () => {
  it("removes the cached async prefix root when the case finishes", async () => {
    const parentDir = await makeParentRoot();

    await withTestDir({ prefix: "openclaw-leak-check-", parentDir }, async (dir) => {
      await fs.writeFile(path.join(dir, "marker.txt"), "ok");
    });

    await expect(fs.readdir(parentDir)).resolves.toStrictEqual([]);
  });

  it("keeps the cached async prefix root while another case is active", async () => {
    const parentDir = await makeParentRoot();
    let releaseFirst: (() => void) | undefined;
    const firstCanFinish = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });

    const first = withTestDir({ prefix: "openclaw-shared-root-", parentDir }, async (dir) => {
      await fs.writeFile(path.join(dir, "first.txt"), "ok");
      await firstCanFinish;
    });

    await withTestDir({ prefix: "openclaw-shared-root-", parentDir }, async (dir) => {
      await fs.writeFile(path.join(dir, "second.txt"), "ok");
      await expect(fs.readdir(parentDir)).resolves.toHaveLength(1);
    });

    if (releaseFirst === undefined) {
      throw new Error("expected first temp-dir release callback");
    }
    releaseFirst();
    await first;

    await expect(fs.readdir(parentDir)).resolves.toStrictEqual([]);
  });

  it("removes the cached sync prefix root when the case finishes", async () => {
    const parentDir = await makeParentRoot();

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
      const parentDir = await makeParentRoot();
      // umask is process-wide and cannot be changed in a Vitest worker thread.
      const stdout = execNodeEvalSync(
        `import fs from "node:fs";
import { tempWorkspaceSync } from "@openclaw/fs-safe/temp";
import { withTestDir, withTempDirSync, createSuiteTempRootTracker } from ${JSON.stringify(new URL("./temp-dir.ts", import.meta.url).href)};
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
        {
          imports: [new URL("../../scripts/tsx.mjs", import.meta.url).href],
          timeout: 10_000,
          killSignal: "SIGKILL",
        },
      );
      expect(JSON.parse(stdout)).toEqual({ result: "private", remaining: [] });
    },
  );
});
