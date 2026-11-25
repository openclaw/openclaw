import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { acquirePackageReleaseLease } from "./package-release-lease.js";
import {
  collectPackageReleases,
  listPackageReleases,
  PACKAGE_RELEASE_MIN_AGE_MS,
} from "./package-release-retention.js";
import {
  capturePackageReleaseSlot,
  isOpenClawOwnedPackagePrefix,
  resolvePackageReleaseTarget,
  switchPackageReleaseLink,
} from "./package-release-slot.js";
import { createPackageReleasePrefixFixture } from "./package-release-slot.test-support.js";
import type { UpdateRunRecord } from "./update-run-record.js";

let dir: string;
beforeEach(() => {
  dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-release-retention-")));
});
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

const noOpenRuns = async () => [];
const releasesOf = (prefix: string) =>
  fs
    .readdirSync(path.join(prefix, "releases"))
    .filter((name) => !name.startsWith("."))
    .toSorted();

async function switchTo(
  fixture: ReturnType<typeof createPackageReleasePrefixFixture>,
  root: string,
) {
  const capture = await capturePackageReleaseSlot(fixture.slot);
  if (capture.kind !== "link") {
    throw new Error("expected a link");
  }
  await switchPackageReleaseLink({
    slot: fixture.slot,
    expected: capture,
    target: path.relative(fixture.globalRoot, root),
    assertCurrent: () => {},
  });
}

describe.skipIf(process.platform === "win32")("release collection", () => {
  it("removes only releases deselected more than a day ago that nothing names", async () => {
    const fixture = createPackageReleasePrefixFixture(dir);
    fixture.addRelease("old", "2026.10.9");
    fixture.addRelease("named", "2026.11.1");
    fixture.addRelease("previous", "2026.11.3");
    const selected = fixture.addRelease("selected", "2026.12.1");
    fixture.linkTo("previous");
    // Selected for weeks: its directory is old until the switch stamps its deselection.
    const installed = new Date(Date.now() - 30 * PACKAGE_RELEASE_MIN_AGE_MS);
    fs.utimesSync(path.join(fixture.prefix, "releases", "previous"), installed, installed);
    await switchTo(fixture, selected);
    const openRun = {
      origin: {
        packageRelease: {
          from: { path: fixture.releaseRoot("named") },
          to: { path: fixture.releaseRoot("selected") },
        },
      },
    } as unknown as UpdateRunRecord;
    fs.mkdirSync(path.join(fixture.prefix, "releases", ".collecting-x-00"));
    // Releases deselected by earlier updates, two days ago.
    const past = new Date(Date.now() - 2 * PACKAGE_RELEASE_MIN_AGE_MS);
    for (const id of ["old", "named"]) {
      fs.utimesSync(path.join(fixture.prefix, "releases", id), past, past);
    }

    // An hour later the just-deselected release is kept, and so is the one an open run names.
    const soon = await collectPackageReleases({
      slot: fixture.slot,
      prefix: fixture.prefix,
      readOpenRuns: async () => [openRun],
      now: Date.now() + 60 * 60 * 1000,
    });
    expect(soon.removed).toEqual([path.join(fixture.prefix, "releases", "old")]);
    expect(releasesOf(fixture.prefix)).toEqual(["named", "previous", "selected"]);
    expect(fs.existsSync(path.join(fixture.prefix, "releases", ".collecting-x-00"))).toBe(false);

    const later = await collectPackageReleases({
      slot: fixture.slot,
      prefix: fixture.prefix,
      readOpenRuns: async () => [openRun],
      now: Date.now() + PACKAGE_RELEASE_MIN_AGE_MS + 60_000,
    });
    expect(later.removed).toEqual([path.join(fixture.prefix, "releases", "previous")]);
    expect(releasesOf(fixture.prefix)).toEqual(["named", "selected"]);
  });

  it("keeps a release a live process leases, and collects it after the lease is released", async () => {
    const fixture = createPackageReleasePrefixFixture(dir);
    const running = fixture.addRelease("running", "2026.11.3");
    const next = fixture.addRelease("next", "2026.12.1");
    fixture.linkTo("running");
    const first = acquirePackageReleaseLease(running);
    const second = acquirePackageReleaseLease(running);
    await switchTo(fixture, next);
    const later = Date.now() + PACKAGE_RELEASE_MIN_AGE_MS + 60_000;
    const collect = () =>
      collectPackageReleases({
        slot: fixture.slot,
        prefix: fixture.prefix,
        readOpenRuns: noOpenRuns,
        now: later,
      });

    // A second registration in the same process keeps its own lease.
    first();
    expect((await collect()).removed).toEqual([]);
    expect(
      (await listPackageReleases(fixture.slot)).find(({ id }) => id === "running"),
    ).toMatchObject({ selected: false, leased: true, version: "2026.11.3" });
    second();
    expect((await collect()).removed).toEqual([path.join(fixture.prefix, "releases", "running")]);
  });

  it("keeps everything when open update runs cannot be read", async () => {
    const fixture = createPackageReleasePrefixFixture(dir);
    fixture.addRelease("old", "2026.10.9");
    fixture.addRelease("selected", "2026.12.1");
    fixture.linkTo("selected");
    const outcome = await collectPackageReleases({
      slot: fixture.slot,
      prefix: fixture.prefix,
      readOpenRuns: async () => {
        throw new Error("database busy");
      },
      now: Date.now() + PACKAGE_RELEASE_MIN_AGE_MS + 60_000,
    });
    expect(outcome).toEqual({
      removed: [],
      warnings: [expect.stringContaining("database busy")],
    });
    expect(releasesOf(fixture.prefix)).toEqual(["old", "selected"]);
  });

  it("collects nothing when the package path is not a release link", async () => {
    const fixture = createPackageReleasePrefixFixture(dir);
    fixture.addRelease("orphan", "2026.10.9");
    fixture.writePlainPackage("2026.11.3");
    const outcome = await collectPackageReleases({
      slot: fixture.slot,
      prefix: fixture.prefix,
      readOpenRuns: noOpenRuns,
      now: Date.now() + PACKAGE_RELEASE_MIN_AGE_MS + 60_000,
    });
    expect(outcome.removed).toEqual([]);
    expect(releasesOf(fixture.prefix)).toEqual(["orphan"]);
  });

  it("takes no lease for a release its link does not select", () => {
    const fixture = createPackageReleasePrefixFixture(dir);
    const unselected = fixture.addRelease("staged", "2026.12.1");
    fixture.addRelease("selected", "2026.11.3");
    fixture.linkTo("selected");
    acquirePackageReleaseLease(unselected)();
    expect(fs.existsSync(path.join(fixture.prefix, "releases", ".leases"))).toBe(false);
  });
});

describe.skipIf(process.platform === "win32")("which installations get release directories", () => {
  it("selects install-cli and durable copies, and leaves other prefixes on the swap", () => {
    const state = path.join(dir, "state");
    const installCli = createPackageReleasePrefixFixture(
      path.join(dir, "cli", "tools", "node-v24.22.1"),
    );
    // The fixture puts its prefix under <dir>/prefix; make that prefix the install-cli shape.
    const tools = path.join(dir, "home", "tools");
    fs.mkdirSync(tools, { recursive: true });
    fs.renameSync(installCli.prefix, path.join(tools, "node-v24.22.1"));
    fs.symlinkSync("node-v24.22.1", path.join(tools, "node"));
    const cliPackage = path.join(tools, "node-v24.22.1", "lib", "node_modules", "openclaw");
    fs.mkdirSync(cliPackage);
    expect(resolvePackageReleaseTarget(cliPackage, { OPENCLAW_STATE_DIR: state })).toEqual({
      slot: cliPackage,
      prefix: path.join(tools, "node-v24.22.1"),
    });

    const durable = path.join(state, "npm", "lib", "node_modules", "openclaw");
    fs.mkdirSync(durable, { recursive: true });
    expect(isOpenClawOwnedPackagePrefix(path.join(state, "npm"), state)).toBe(true);
    expect(resolvePackageReleaseTarget(durable, { OPENCLAW_STATE_DIR: state })?.slot).toBe(durable);

    // An npm prefix the user manages, nvm's layout, and a missing package keep the swap.
    for (const prefix of [
      path.join(dir, "usr-local"),
      path.join(dir, ".nvm", "versions", "node", "v24.22.1"),
    ]) {
      const packageRoot = path.join(prefix, "lib", "node_modules", "openclaw");
      fs.mkdirSync(packageRoot, { recursive: true });
      expect(resolvePackageReleaseTarget(packageRoot, { OPENCLAW_STATE_DIR: state })).toBeNull();
    }
    expect(
      resolvePackageReleaseTarget(path.join(dir, "missing", "lib", "node_modules", "openclaw"), {
        OPENCLAW_STATE_DIR: state,
      }),
    ).toBeNull();
    // Without the `tools/node` link the same directory name is not install-cli's.
    fs.rmSync(path.join(tools, "node"));
    expect(resolvePackageReleaseTarget(cliPackage, { OPENCLAW_STATE_DIR: state })).toBeNull();
  });
});
