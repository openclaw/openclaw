import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { WorkerTaskError } from "../../infra/worker-task-pool.js";
import * as manifestWorker from "./workspace-manifest-worker.js";
import { prepareNonDirectoryTargets } from "./workspace-reconcile-derived-paths.js";
import { absoluteEntryMatches } from "./workspace-reconcile-fs.js";

const temporary = useAutoCleanupTempDirTracker(afterEach);
afterEach(() => vi.restoreAllMocks());

it("prepares directory replacements without following links or touching other targets", async () => {
  const root = temporary.make("workspace-cleanup-targets-");
  await fs.mkdir(path.join(root, "replace", "__pycache__"), { recursive: true });
  await fs.writeFile(path.join(root, "replace", "__pycache__", "cache.pyc"), "cache");
  await fs.mkdir(path.join(root, "retained", "__pycache__"), { recursive: true });
  await fs.writeFile(path.join(root, "retained", "__pycache__", "cache.pyc"), "retained cache");
  await fs.writeFile(path.join(root, "file"), "local file");
  await fs.symlink("retained", path.join(root, "link"));
  await fs.symlink("loop", path.join(root, "loop"));
  await prepareNonDirectoryTargets(
    root,
    [
      "replace",
      "file",
      "missing/child",
      "file/child",
      "link",
      "link/__pycache__",
      "loop/child",
    ].map((entryPath) => ({
      path: entryPath,
      type: "symlink",
      mode: 0o777,
      target: "replacement",
    })),
  );
  await expect(fs.lstat(path.join(root, "replace"))).rejects.toMatchObject({ code: "ENOENT" });
  await expect(fs.readFile(path.join(root, "file"), "utf8")).resolves.toBe("local file");
  await expect(fs.readlink(path.join(root, "link"))).resolves.toBe("retained");
  await expect(fs.readlink(path.join(root, "loop"))).resolves.toBe("loop");
  await expect(
    fs.readFile(path.join(root, "retained", "__pycache__", "cache.pyc"), "utf8"),
  ).resolves.toBe("retained cache");
});

it("does not turn a compute outage into a conflicting file", async () => {
  const root = temporary.make("workspace-verify-worker-");
  const file = path.join(root, "file.txt");
  const content = "input";
  await fs.writeFile(file, content);
  const entry = {
    path: "file.txt",
    type: "file" as const,
    mode: 0o644,
    size: content.length,
    sha256: createHash("sha256").update(content).digest("hex"),
  };
  const verify = () => absoluteEntryMatches(file, entry);
  const failure = new WorkerTaskError("workspace worker unavailable", "unavailable");
  const snapshot = vi
    .spyOn(manifestWorker, "computeWorkspaceFileSnapshot")
    .mockRejectedValueOnce(failure);
  await expect(verify()).rejects.toBe(failure);

  snapshot.mockRejectedValueOnce(new Error("file changed while it was being read"));
  await expect(verify()).resolves.toBe(false);
});
