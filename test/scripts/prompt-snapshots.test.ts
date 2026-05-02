import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  createFormattedPromptSnapshotFiles,
  deleteStalePromptSnapshotFiles,
} from "../../scripts/generate-prompt-snapshots.js";
import { HAPPY_PATH_PROMPT_SNAPSHOT_DIR } from "../helpers/agents/happy-path-prompt-snapshots.js";

describe("happy path prompt snapshots", () => {
  it("matches the committed Codex prompt snapshot artifacts", async () => {
    const generated = await createFormattedPromptSnapshotFiles();
    const expectedPaths = new Set(generated.map((file) => file.path));
    for (const file of generated) {
      expect(fs.readFileSync(file.path, "utf8"), file.path).toBe(file.content);
    }
    const committed = fs
      .readdirSync(HAPPY_PATH_PROMPT_SNAPSHOT_DIR)
      .filter((entry) => entry.endsWith(".md") || entry.endsWith(".json"))
      .map((entry) => path.join(HAPPY_PATH_PROMPT_SNAPSHOT_DIR, entry));
    expect(committed.toSorted()).toEqual([...expectedPaths].toSorted());
  });

  it("deletes stale generated snapshot artifacts", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-prompt-snapshot-stale-"));
    try {
      const snapshotDir = path.join(root, HAPPY_PATH_PROMPT_SNAPSHOT_DIR);
      fs.mkdirSync(snapshotDir, { recursive: true });
      const stalePath = path.join(HAPPY_PATH_PROMPT_SNAPSHOT_DIR, "stale-snapshot.md");
      fs.writeFileSync(path.join(root, stalePath), "stale\n");

      const deleted = await deleteStalePromptSnapshotFiles(root, [
        { path: path.join(HAPPY_PATH_PROMPT_SNAPSHOT_DIR, "current.md") },
      ]);

      expect(deleted).toEqual([stalePath]);
      expect(fs.existsSync(path.join(root, stalePath))).toBe(false);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
