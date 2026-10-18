import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { runCommandWithTimeout } from "../../process/exec.js";
import { readActualWorkspaceManifestImpl } from "./workspace-actual-manifest.js";
import { DERIVED_WORKSPACE_RSYNC_EXCLUDES } from "./workspace-path-exclusions.js";
import { REMOTE_WORKSPACE_MANIFEST_JS } from "./workspace-sync-scripts.js";
import {
  createScriptWorkspace,
  writeWorkspaceFiles,
  workspaceScriptRunner,
} from "./workspace-sync-scripts.test-support.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const cache = ".cache/vitest/results.json";
const lock = ".artifacts/dist-artifacts.lock/owner.json";
const userFiles = {
  ".gitignore": ".artifacts/\n.cache/\n",
  ".artifacts/report.md": "user report\n",
  ".cache/user-data.json": "user data\n",
  ".cache/vitest-input.txt": "user fixture\n",
  ".artifacts/dist-artifacts.lock-notes": "user notes\n",
  "fixtures/.cache/vitest/input.json": "nested user fixture\n",
};

it("excludes only generated runtime roots from capture and transfer", async () => {
  const { home, workspace, env } = await createScriptWorkspace(
    tempDirs.make("workspace-generated-capture-"),
  );
  await writeWorkspaceFiles(workspace, {
    ...userFiles,
    "source.ts": "source edit\n",
    [cache]: "test cache\n",
    [lock]: "transient owner\n",
  });
  const local = await readActualWorkspaceManifestImpl({ root: workspace, baseCommit: null });
  const run = workspaceScriptRunner(REMOTE_WORKSPACE_MANIFEST_JS, workspace, env);
  const remote = await run(["", "all"]);
  expect(remote.code, remote.stderr).toBe(0);
  const raw = await fs.readFile(
    path.join(home, ".openclaw-worker/manifests", `${remote.stdout.trim().slice(7)}.json`),
    "utf8",
  );
  const expected = [...Object.keys(userFiles), "source.ts"].toSorted();
  expect(local.manifest.entries.map((entry) => entry.path).toSorted()).toEqual(expected);
  const captured: { entries: Array<{ path: string; type: string }> } = JSON.parse(raw);
  expect(
    captured.entries
      .filter((entry) => entry.type !== "directory")
      .map((entry) => entry.path)
      .toSorted(),
  ).toEqual(expected);
  if (process.platform !== "win32") {
    const target = tempDirs.make("workspace-generated-transfer-");
    const transfer = await runCommandWithTimeout(
      [
        "rsync",
        "--archive",
        ...DERIVED_WORKSPACE_RSYNC_EXCLUDES.map((entry) => `--exclude=${entry}`),
        `${workspace}/`,
        `${target}/`,
      ],
      { timeoutMs: 10_000 },
    );
    expect(transfer.code, transfer.stderr).toBe(0);
    for (const name of [cache, lock]) {
      await expect(fs.stat(path.join(target, name))).rejects.toMatchObject({ code: "ENOENT" });
    }
    for (const [name, content] of Object.entries(userFiles)) {
      expect(await fs.readFile(path.join(target, name), "utf8")).toBe(content);
    }
  }
});
