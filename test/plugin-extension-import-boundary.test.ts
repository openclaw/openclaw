// Plugin extension import boundary tests enforce plugin extension import rules.
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  collectRetiredSkillWorkshopCorePathEntries,
  collectRetiredWebSearchCorePathEntries,
} from "../scripts/check-plugin-extension-import-boundary.mts";
import { useAutoCleanupTempDirTracker } from "./helpers/temp-dir.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

describe("plugin extension import boundary inventory", () => {
  it("rejects retired core web-search ownership paths", () => {
    const root = tempDirs.make("openclaw-retired-web-search-");
    const relativeFile = "src/plugins/web-search-providers.mjs";
    const filePath = path.join(root, relativeFile);
    mkdirSync(path.dirname(filePath), { recursive: true });
    writeFileSync(filePath, "export {};\n", "utf8");

    expect(collectRetiredWebSearchCorePathEntries(root)).toEqual([
      expect.objectContaining({
        file: relativeFile,
        kind: "retired-path",
      }),
    ]);
  });

  it("rejects restored core Skill Workshop modules", () => {
    const root = tempDirs.make("openclaw-retired-skill-workshop-");
    const relativeFile = "src/skills/workshop/library.ts";
    mkdirSync(path.dirname(path.join(root, relativeFile)), { recursive: true });
    writeFileSync(path.join(root, relativeFile), "export {};\n", "utf8");

    expect(collectRetiredSkillWorkshopCorePathEntries(root)).toEqual([
      expect.objectContaining({ file: "src/skills/workshop", kind: "retired-path" }),
    ]);
  });
});
