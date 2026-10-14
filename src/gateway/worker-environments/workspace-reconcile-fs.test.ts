import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { WorkerTaskError } from "../../infra/worker-task-pool.js";
import * as manifestWorker from "./workspace-manifest-worker.js";
import { absoluteEntryMatches, entryMatches } from "./workspace-reconcile-fs.js";

const temporary = useAutoCleanupTempDirTracker(afterEach);
afterEach(() => vi.restoreAllMocks());

it.each(["absolute", "relative"] as const)(
  "does not turn a compute outage into a conflicting %s file",
  async (kind) => {
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
    const verify = () =>
      kind === "absolute" ? absoluteEntryMatches(file, entry) : entryMatches(root, entry);
    const failure = new WorkerTaskError("workspace worker unavailable", "unavailable");
    const snapshot = vi
      .spyOn(manifestWorker, "computeWorkspaceFileSnapshot")
      .mockRejectedValueOnce(failure);
    await expect(verify()).rejects.toBe(failure);

    snapshot.mockRejectedValueOnce(new Error("file changed while it was being read"));
    await expect(verify()).resolves.toBe(false);
  },
);
