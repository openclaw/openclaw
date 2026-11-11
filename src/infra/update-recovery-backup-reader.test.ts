import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import {
  UPDATE_CAPTURE_PRIVACY_MARKER,
  UPDATE_CAPTURE_PRIVACY_MARKER_CONTENT,
} from "./update-capture-privacy-marker.js";
import { readUpdateRecoveryBaselineIdentity } from "./update-recovery-backup-reader.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

async function retainedBaseline(spelling: "alias" | "case" = "alias") {
  const root = tempDirs.make("update-recovery-scope-");
  const home = path.join(root, "home");
  const stateDir = path.join(home, "state");
  await fs.mkdir(stateDir, { recursive: true });
  const recordedHome = path.join(root, spelling === "case" ? "HOME" : "old-home");
  if (spelling === "alias") {
    await fs.symlink(home, recordedHome, process.platform === "win32" ? "junction" : "dir");
  }
  const recordedState = path.join(recordedHome, "state");
  const configPath = path.join(stateDir, "openclaw.json");
  const recordedConfig = path.join(recordedState, "openclaw.json");
  const runId = "retained-baseline";
  const installRoot = path.join(root, "install");
  // A sealed older-producer fixture, not the current capture writer: that writer
  // would canonicalize away the historical spelling this reader must accept.
  const manifest = {
    schemaVersion: 2,
    kind: "update-recovery",
    generation: { kind: "baseline" },
    databases: [],
    runId,
    installRoot,
    stateDir: recordedState,
    configPath: recordedConfig,
    configPaths: [recordedConfig],
    creator: { host: "fixture", pid: 1, startIdentity: "1" },
    drivers: [],
    createdAt: "2026-09-10T00:00:00.000Z",
    roots: [recordedState],
    excludedRoots: [],
    protectedPaths: [recordedConfig],
    entries: [
      { kind: "directory", sourcePath: recordedState, mode: 0o700 },
      { kind: "missing", sourcePath: recordedConfig, sqlite: false, directory: false },
    ],
  };
  const directory = path.join(`${recordedState}.update-captures`, runId);
  await fs.mkdir(directory, { recursive: true });
  await fs.writeFile(
    path.join(directory, UPDATE_CAPTURE_PRIVACY_MARKER),
    UPDATE_CAPTURE_PRIVACY_MARKER_CONTENT,
  );
  const manifestPath = path.join(directory, "manifest.json");
  const raw = JSON.stringify(manifest);
  await fs.writeFile(manifestPath, raw);
  const ref = {
    directory,
    manifestPath,
    manifestSha256: createHash("sha256").update(raw).digest("hex"),
  };
  const env: NodeJS.ProcessEnv = {
    HOME: home,
    USERPROFILE: home,
    OPENCLAW_HOME: home,
    OPENCLAW_STATE_DIR: stateDir,
    OPENCLAW_CONFIG_PATH: configPath,
  };
  const read = (selected = env) =>
    readUpdateRecoveryBaselineIdentity({
      runId,
      env: selected,
      ref,
      installRoot,
      // Explicit admitted references do not require an implicit ledger lookup.
      readContinuation: () => undefined,
      assertCurrent: () => {},
    });
  return { root, stateDir, recordedState, configPath, manifest, raw, ref, env, read };
}

async function expectRetained(fixture: Awaited<ReturnType<typeof retainedBaseline>>) {
  expect(fixture.recordedState).not.toBe(fixture.stateDir);
  const recorded = await fs.stat(fixture.recordedState, { bigint: true });
  const selected = await fs.stat(fixture.stateDir, { bigint: true });
  expect([recorded.dev, recorded.ino]).toEqual([selected.dev, selected.ino]);
  expect(await fixture.read()).toEqual({ ref: fixture.ref, manifest: fixture.manifest });
  expect(await fs.readFile(fixture.ref.manifestPath, "utf8")).toBe(fixture.raw);
  expect((await fs.readdir(fixture.ref.directory)).toSorted()).toEqual(
    [UPDATE_CAPTURE_PRIVACY_MARKER, "manifest.json"].toSorted(),
  );
}

it("admits an older alias spelling with an absent config and preserves its seal", async () => {
  const fixture = await retainedBaseline();
  await expectRetained(fixture);
  await expect(fs.lstat(fixture.configPath)).rejects.toMatchObject({ code: "ENOENT" });
});

it.skipIf(process.platform !== "win32")(
  "admits Windows directory case aliases in a retained baseline",
  async () => {
    await expectRetained(await retainedBaseline("case"));
  },
);

it("rejects a retained baseline belonging to a different selected state", async () => {
  const fixture = await retainedBaseline();
  const otherState = path.join(fixture.root, "other-state");
  await fs.mkdir(otherState);
  await expect(fixture.read({ ...fixture.env, OPENCLAW_STATE_DIR: otherState })).rejects.toThrow(
    "another selected state or configuration",
  );
});

it("rejects a different absent configuration entry in the same selected state", async () => {
  const fixture = await retainedBaseline();
  await expect(
    fixture.read({
      ...fixture.env,
      OPENCLAW_CONFIG_PATH: path.join(fixture.stateDir, "other.json"),
    }),
  ).rejects.toThrow("another selected state or configuration");
});

it.each(["symlink", "hardlink"] as const)(
  "keeps the final config entry distinct from its %s target",
  async (kind) => {
    const fixture = await retainedBaseline();
    const target = path.join(fixture.stateDir, "target.json");
    await fs.writeFile(target, "{}\n");
    if (kind === "symlink") {
      await fs.symlink(target, fixture.configPath, "file");
    } else {
      await fs.link(target, fixture.configPath);
    }
    // Identity admission does not restore or read live config content. The same
    // recorded entry remains selected, even if its live file kind has changed.
    await expectRetained(fixture);
    await expect(
      fixture.read({ ...fixture.env, OPENCLAW_CONFIG_PATH: target }),
    ).rejects.toThrow("another selected state or configuration");
    expect(await fs.readFile(target, "utf8")).toBe("{}\n");
    expect((await fs.lstat(fixture.configPath)).isSymbolicLink()).toBe(kind === "symlink");
  },
);
