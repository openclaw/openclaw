import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";
import {
  createProvisionOwnerFixture,
  expectProvisionLeaseReleased,
  expectProvisionSeed,
} from "./pr-worktree-owner.test-support.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const describePosix = process.platform === "win32" ? describe.skip : describe;

describePosix("repository-owned PR provisioning state", () => {
  it.runIf(process.platform === "linux")(
    "releases its completed operation after exited loader descendants await reaping",
    () => {
      const f = createProvisionOwnerFixture(tempDirs.make("openclaw-pr-exited-loaders-"));
      delete f.env.OPENCLAW_CONFIG_PATH;
      const result = f.run("entry", "", { holdExitedDescendants: true });
      expect(result.status, result.stdout + result.stderr).toBe(0);
      expect(result.stdout).toMatch(/successfully reaped: [1-9]/u);
      expectProvisionSeed(f);
      expectProvisionLeaseReleased(f);
      expect(f.git(f.canonical, "for-each-ref", "refs/openclaw/pr-operation-locks")).toBe("");
      expect(existsSync(join(f.home, ".openclaw"))).toBe(false);
    },
  );
  it.each([
    { mode: "native", override: false },
    { mode: "native", override: true },
    { mode: "managed", override: false },
    { mode: "managed", override: true },
  ] as const)(
    "isolates $mode state from HOME (operator override=$override)",
    ({ mode, override }) => {
      const f = createProvisionOwnerFixture(tempDirs.make("openclaw-pr-state-"), mode);
      // On supported filesystems, this also exercises the template registry writer.
      writeFileSync(f.env.OPENCLAW_CONFIG_PATH!, "{}\n");
      const operator = join(f.root, "operator-state");
      if (override) {
        mkdirSync(operator);
        writeFileSync(join(operator, "operator-evidence"), "leave untouched");
        f.env.OPENCLAW_STATE_DIR = operator;
      } else {
        delete f.env.OPENCLAW_CONFIG_PATH;
      }
      const result = f.run();
      expect(result.status, result.stderr).toBe(0);
      expectProvisionSeed(f);
      expect(existsSync(join(f.home, ".openclaw"))).toBe(false);
      expect(existsSync(join(f.canonical, ".local", "pr-state", "state", "openclaw.sqlite"))).toBe(
        true,
      );
      expectProvisionLeaseReleased(f);
      if (override) {
        expect(readdirSync(operator)).toEqual(["operator-evidence"]);
        expect(readFileSync(join(operator, "operator-evidence"), "utf8")).toBe("leave untouched");
      } else {
        expect(existsSync(operator)).toBe(false);
      }
    },
  );
});
