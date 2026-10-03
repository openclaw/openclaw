import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import {
  CommandProcessCleanupError,
  hasCommandProcessCleanupError,
} from "../process/exec-result.js";
import { runCommandWithTimeout } from "../process/exec.js";
import { withTestDir } from "../test-helpers/temp-dir.js";
import { installPackageDir } from "./install-package-dir.js";

vi.mock("../process/exec.js", () => ({ runCommandWithTimeout: vi.fn() }));
afterEach(() => vi.mocked(runCommandWithTimeout).mockReset());

it.each(["returned", "thrown"])(
  "retains an unsettled npm stage and the previous install (%s cleanup failure)",
  async (outcome) => {
    await withTestDir({ prefix: "install-unsettled-" }, async (root) => {
      const sourceDir = path.join(root, "source");
      const targetDir = path.join(root, "installed", "plugin");
      await fs.mkdir(sourceDir, { recursive: true });
      await fs.mkdir(targetDir, { recursive: true });
      await fs.writeFile(path.join(targetDir, "marker"), "working");
      await fs.writeFile(
        path.join(sourceDir, "package.json"),
        JSON.stringify({
          name: "synthetic-package",
          version: "1.0.0",
          dependencies: { synthetic: "1.0.0" },
        }),
      );
      let stage = "";
      vi.mocked(runCommandWithTimeout).mockImplementation(async (_argv, options) => {
        if (typeof options === "number" || !options.cwd) {
          throw new Error("Expected private npm cwd");
        }
        stage = options.cwd;
        await fs.writeFile(path.join(stage, "writer-owned"), "unsettled");
        if (outcome === "thrown") {
          throw new CommandProcessCleanupError();
        }
        return {
          stdout: "",
          stderr: "",
          code: 1,
          signal: null,
          killed: true,
          termination: "timeout",
          cleanup: "uncertain",
        };
      });
      const error = await installPackageDir({
        sourceDir,
        targetDir,
        mode: "update",
        timeoutMs: 1000,
        hasDeps: true,
        copyErrorPrefix: "synthetic",
        depsLogMessage: "synthetic",
      }).catch((caught: unknown) => caught);
      expect(hasCommandProcessCleanupError(error)).toBe(true);
      expect(stage).not.toBe(targetDir);
      expect(await fs.readFile(path.join(stage, "writer-owned"), "utf8")).toBe("unsettled");
      expect(await fs.readFile(path.join(targetDir, "marker"), "utf8")).toBe("working");
      // No process is spawned by this fixture; its private stage can now be removed.
    });
  },
);
