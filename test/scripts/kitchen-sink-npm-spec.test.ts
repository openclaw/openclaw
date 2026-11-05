import { spawnSync } from "node:child_process";
import { copyFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

describe("Kitchen Sink npm fixture", () => {
  it.each([undefined, "invalid", "1.2.3-beta.4"])(
    "reads the branch record lazily and respects overrides (record=%s)",
    (version) => {
      const root = tempDirs.make("kitchen-sink-npm-");
      const modulePath = join(root, "npm-spec.mts");
      copyFileSync("scripts/e2e/lib/kitchen-sink-plugin/npm-spec.mts", modulePath);
      if (version !== undefined) {
        writeFileSync(join(root, "npm-version.txt"), version);
      }
      const run = (override: string) =>
        spawnSync(
          process.execPath,
          [
            "--input-type=module",
            "--eval",
            `const {resolveKitchenSinkNpmSpec} = await import(${JSON.stringify(pathToFileURL(modulePath).href)});
        console.log(resolveKitchenSinkNpmSpec({OPENCLAW_KITCHEN_SINK_NPM_SPEC: ${JSON.stringify(override)}}));`,
          ],
          { encoding: "utf8" },
        );
      const explicit = run("npm-pack:/fixture/plugin.tgz");
      expect(explicit.status, explicit.stderr).toBe(0);
      expect(explicit.stdout.trim()).toBe("npm-pack:/fixture/plugin.tgz");
      const recorded = run("");
      if (version === "1.2.3-beta.4") {
        expect(recorded.status, recorded.stderr).toBe(0);
        expect(recorded.stdout.trim()).toBe("npm:@openclaw/kitchen-sink@1.2.3-beta.4");
      } else {
        expect(recorded.status).not.toBe(0);
        expect(recorded.stderr).toContain(
          version === undefined
            ? "npm-version.txt"
            : "Invalid branch-recorded Kitchen Sink npm version",
        );
      }
    },
  );
});
