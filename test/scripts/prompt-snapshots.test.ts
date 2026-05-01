import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { createFormattedPromptSnapshotFiles } from "../../scripts/generate-prompt-snapshots.js";
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
});
