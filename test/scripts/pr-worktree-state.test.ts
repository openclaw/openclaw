import {
  copyFileSync,
  existsSync,
  linkSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
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
      f.isolation.assertProvisioner();
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
      // The native entrypoints carry explicit argv binding, not NODE_OPTIONS.
      if (override) {
        f.env.NODE_OPTIONS = "--no-warnings";
      } else {
        delete f.env.NODE_OPTIONS;
      }
      const result = f.run();
      expect(result.status, result.stderr).toBe(0);
      f.isolation.assertProvisioner();
      expectProvisionSeed(f);
      expect(existsSync(join(f.home, ".openclaw"))).toBe(false);
      expect(existsSync(join(f.canonical, ".local", "pr-state", "state", "openclaw.sqlite"))).toBe(
        true,
      );
      expectProvisionLeaseReleased(f);
      expect(f.git(f.canonical, "for-each-ref", "refs/openclaw/pr-operation-locks")).toBe("");
      if (override) {
        expect(readdirSync(operator)).toEqual(["operator-evidence"]);
        expect(readFileSync(join(operator, "operator-evidence"), "utf8")).toBe("leave untouched");
      } else {
        expect(existsSync(operator)).toBe(false);
      }
    },
  );

  it("refuses a fresh provisioner whose handoff argv binding was stripped", () => {
    const f = createProvisionOwnerFixture(tempDirs.make("openclaw-pr-stripped-binding-"));
    const quote = (value: string) => `'${value.replace(/'/gu, `'\\''`)}'`;
    // Keep the pre-open observer but remove only the child's resolver import.
    // The parent still has a valid binding: its witness cannot qualify this PID.
    writeFileSync(
      join(f.isolation.bin, "node"),
      `#!/bin/sh\nexec ${quote(process.execPath)} ${quote(f.isolation.nodeArgs[1]!)} "$@"\n`,
    );
    const result = f.run();
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("Missing private provisioner handoff preload");
    expect(readFileSync(f.isolation.observations, "utf8")).toBe("");
    expect(existsSync(f.isolation.binding.databasePath)).toBe(false);
    expect(existsSync(f.isolation.stateDatabase)).toBe(false);
  });

  it.each(["missing", "replaced"] as const)(
    "refuses a %s binding directory before opening either store",
    (fault) => {
      const f = createProvisionOwnerFixture(tempDirs.make("openclaw-pr-binding-identity-"));
      const preload = fileURLToPath(f.isolation.binding.nodeOption.slice("--import=".length));
      if (fault === "missing") {
        unlinkSync(preload);
      } else {
        const retained = join(f.root, "replaced-handoff");
        renameSync(f.isolation.binding.directory, retained);
        mkdirSync(f.isolation.binding.directory, { mode: 0o700 });
        copyFileSync(join(retained, "handoff-resolver-preload.mjs"), preload);
      }
      const result = f.run();
      expect(result.status).not.toBe(0);
      expect(result.stderr).toMatch(
        fault === "missing" ? /ERR_MODULE_NOT_FOUND/ : /directory identity changed/,
      );
      expect(readFileSync(f.isolation.observations, "utf8")).toBe("");
      expect(existsSync(f.isolation.binding.databasePath)).toBe(false);
      expect(existsSync(f.isolation.stateDatabase)).toBe(false);
    },
  );

  it.each([
    { kind: "symlink", suffix: "" },
    { kind: "hardlink", suffix: "" },
    { kind: "symlink", suffix: "-wal" },
    { kind: "hardlink", suffix: "-wal" },
  ] as const)("refuses a handoff $kind $suffix before store access", ({ kind, suffix }) => {
    const f = createProvisionOwnerFixture(tempDirs.make("openclaw-pr-binding-alias-"));
    const target = join(f.root, "private-negative-control");
    writeFileSync(target, "do not open", { mode: 0o600 });
    const alias = f.isolation.binding.databasePath + suffix;
    if (kind === "symlink") {
      symlinkSync(target, alias);
    } else {
      linkSync(target, alias);
    }
    const result = f.run();
    expect(result.status).not.toBe(0);
    expect(result.stderr).toMatch(/database (alias|hardlink) is forbidden/);
    expect(readFileSync(target, "utf8")).toBe("do not open");
    expect(readFileSync(f.isolation.observations, "utf8")).toBe("");
    expect(existsSync(f.isolation.stateDatabase)).toBe(false);
  });
});
