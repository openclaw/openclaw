import fs from "node:fs";
import path from "node:path";
import ts from "typescript";
import { afterEach, describe, expect, it } from "vitest";
import { collectNpmPackInventory } from "../../scripts/lib/npm-pack-inventory.mts";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { runPluginsInitCommand } from "./plugins-authoring-command.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

describe("plugin scaffold compilation", () => {
  it.each(["tool", "provider"] as const)(
    "keeps test files out of compiled and packed %s scaffolds",
    async (type) => {
      const projectDir = path.join(tempDirs.make("openclaw-scaffold-compile-"), "project");
      await runPluginsInitCommand("compile-proof", { directory: projectDir, type });
      fs.writeFileSync(
        path.join(projectDir, "src/index.ts"),
        'export { helper } from "./helper.js";',
      );
      fs.writeFileSync(
        path.join(projectDir, "src/helper.ts"),
        'export const helper = "production";',
      );
      fs.writeFileSync(path.join(projectDir, "src/index.test.ts"), 'throw new Error("test only");');

      const config = JSON.parse(fs.readFileSync(path.join(projectDir, "tsconfig.json"), "utf8"));
      const parsed = ts.parseJsonConfigFileContent(config, ts.sys, projectDir);
      expect(parsed.errors).toEqual([]);
      const program = ts.createProgram(parsed.fileNames, parsed.options);
      expect(ts.getPreEmitDiagnostics(program)).toEqual([]);
      expect(program.emit().emitSkipped).toBe(false);
      const files = fs.readdirSync(path.join(projectDir, "dist")).toSorted();
      expect(files).toEqual(
        type === "tool"
          ? ["helper.d.ts", "helper.js", "index.d.ts", "index.js"]
          : ["helper.js", "index.js"],
      );
      const packed = collectNpmPackInventory(projectDir, { timeoutMs: 30_000 });
      expect(packed.files).toContain("dist/helper.js");
      expect(packed.files).toContain("dist/index.js");
      expect(packed.files.some((file) => file.includes(".test."))).toBe(false);
    },
  );

  it("keeps the feature scaffold browser entry in its TypeScript compilation", async () => {
    const projectDir = path.join(tempDirs.make("openclaw-feature-compile-"), "project");
    await runPluginsInitCommand("compile-proof", { directory: projectDir, type: "feature" });
    const config = JSON.parse(fs.readFileSync(path.join(projectDir, "tsconfig.json"), "utf8"));
    const parsed = ts.parseJsonConfigFileContent(config, ts.sys, projectDir);
    expect(parsed.errors).toEqual([]);
    expect(parsed.fileNames.map((file) => path.relative(projectDir, file))).toContain(
      path.join("src", "control-ui.ts"),
    );
  });
});
