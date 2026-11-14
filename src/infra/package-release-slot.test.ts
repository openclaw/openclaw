import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resolveOpenClawInstallationRootSync } from "./openclaw-root.js";
import {
  readPackageReleaseSlotSync,
  resolvePackageReleaseSlotForRootSync,
} from "./package-release-slot-path.js";
import {
  adoptPackageReleaseSlot,
  assertPackageReleaseIdentity,
  assertPackageReleaseLaunchers,
  capturePackageReleaseSlot,
  createPackageReleasePrefix,
  readPackageReleaseIdentity,
  switchPackageReleaseLink,
} from "./package-release-slot.js";
import { createPackageReleasePrefixFixture } from "./package-release-slot.test-support.js";
import { resolveUpdateInstallRoot, updateInstallRootsMatch } from "./update-install-root.js";

let dir: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-release-slot-"));
});
afterEach(() => {
  vi.restoreAllMocks();
  fs.rmSync(dir, { recursive: true, force: true });
});

const current = () => {};

describe.skipIf(process.platform === "win32")("release slot recognition", () => {
  it("keeps the link path as the installation identity across a release switch", async () => {
    const fixture = createPackageReleasePrefixFixture(dir);
    const first = fixture.addRelease("r1", "2026.11.3");
    const second = fixture.addRelease("r2", "2026.12.1");
    fixture.linkTo("r1");

    expect(resolveUpdateInstallRoot(fixture.slot)).toBe(fixture.slot);
    // A start through the bin launcher reaches the release by its real path.
    expect(resolveOpenClawInstallationRootSync(first, fixture.launcher)).toBe(fixture.slot);

    const capture = await capturePackageReleaseSlot(fixture.slot);
    if (capture.kind !== "link") {
      throw new Error("expected a link");
    }
    await switchPackageReleaseLink({
      slot: fixture.slot,
      expected: capture,
      target: path.relative(fixture.globalRoot, second),
      assertCurrent: current,
    });

    expect(fs.realpathSync(fixture.slot)).toBe(second);
    expect(resolveUpdateInstallRoot(fixture.slot)).toBe(fixture.slot);
    // The selected release is the same installation by its real path; a deselected one is not.
    expect(resolveUpdateInstallRoot(second)).toBe(fixture.slot);
    expect(resolveUpdateInstallRoot(first)).toBe(first);
    expect(updateInstallRootsMatch(fixture.slot, second)).toBe(true);
    expect(updateInstallRootsMatch(second, fixture.slot)).toBe(true);
    expect(updateInstallRootsMatch(fixture.slot, first)).toBe(false);
    expect(resolveOpenClawInstallationRootSync(second, fixture.launcher)).toBe(fixture.slot);
    // A process still running the deselected release is not the installation.
    expect(resolveOpenClawInstallationRootSync(first, fixture.launcher)).toBe(first);
  });

  it("leaves npm link checkouts, plain directories and foreign targets on their real paths", () => {
    const fixture = createPackageReleasePrefixFixture(dir);
    const checkout = path.join(fs.realpathSync(dir), "checkout");
    fs.mkdirSync(checkout);
    fs.writeFileSync(path.join(checkout, "package.json"), JSON.stringify({ name: "openclaw" }));
    fs.symlinkSync(checkout, fixture.slot);
    expect(readPackageReleaseSlotSync(fixture.slot)).toBeNull();
    expect(resolveUpdateInstallRoot(fixture.slot)).toBe(checkout);
    expect(resolveOpenClawInstallationRootSync(checkout, path.join(checkout, "openclaw.mjs"))).toBe(
      checkout,
    );

    // A hidden name under releases/ is never a release.
    const hidden = fixture.addRelease(".stage", "2026.12.1");
    fixture.linkTo(".stage");
    expect(readPackageReleaseSlotSync(fixture.slot)).toBeNull();
    expect(resolvePackageReleaseSlotForRootSync(hidden)).toBeNull();

    fs.rmSync(fixture.slot);
    fixture.writePlainPackage("2026.11.3");
    expect(readPackageReleaseSlotSync(fixture.slot)).toBeNull();
    expect(resolveUpdateInstallRoot(fixture.slot)).toBe(fixture.slot);
  });

  it("does not treat a release of another prefix as this prefix's release", () => {
    const fixture = createPackageReleasePrefixFixture(dir);
    const other = createPackageReleasePrefixFixture(path.join(dir, "other"));
    const foreign = other.addRelease("r1", "2026.11.3");
    fs.symlinkSync(foreign, fixture.slot);
    expect(readPackageReleaseSlotSync(fixture.slot)).toBeNull();
    expect(resolveUpdateInstallRoot(fixture.slot)).toBe(foreign);
  });
});

describe.skipIf(process.platform === "win32")("release link lifecycle", () => {
  it("refuses a switch when the link changed after capture and leaves no temporary link", async () => {
    const fixture = createPackageReleasePrefixFixture(dir);
    fixture.addRelease("r1", "2026.11.3");
    const second = fixture.addRelease("r2", "2026.12.1");
    const third = fixture.addRelease("r3", "2026.12.2");
    fixture.linkTo("r1");
    const capture = await capturePackageReleaseSlot(fixture.slot);
    if (capture.kind !== "link") {
      throw new Error("expected a link");
    }
    // Another writer repoints the link after capture.
    fixture.linkTo("r3");

    await expect(
      switchPackageReleaseLink({
        slot: fixture.slot,
        expected: capture,
        target: path.relative(fixture.globalRoot, second),
        assertCurrent: current,
      }),
    ).rejects.toThrow(/changed since it was captured/u);
    expect(fs.realpathSync(fixture.slot)).toBe(third);
    expect(fs.readdirSync(fixture.globalRoot)).toEqual(["openclaw"]);
  });

  it("checks lease ownership before the rename and keeps the old link on loss", async () => {
    const fixture = createPackageReleasePrefixFixture(dir);
    const first = fixture.addRelease("r1", "2026.11.3");
    const second = fixture.addRelease("r2", "2026.12.1");
    fixture.linkTo("r1");
    const capture = await capturePackageReleaseSlot(fixture.slot);
    if (capture.kind !== "link") {
      throw new Error("expected a link");
    }
    await expect(
      switchPackageReleaseLink({
        slot: fixture.slot,
        expected: capture,
        target: path.relative(fixture.globalRoot, second),
        assertCurrent: () => {
          throw new Error("lease lost");
        },
      }),
    ).rejects.toThrow("lease lost");
    expect(fs.realpathSync(fixture.slot)).toBe(first);
    expect(fs.readdirSync(fixture.globalRoot)).toEqual(["openclaw"]);
  });

  it("removes leftover temporary links before switching, never directories", async () => {
    const fixture = createPackageReleasePrefixFixture(dir);
    fixture.addRelease("r1", "2026.11.3");
    const second = fixture.addRelease("r2", "2026.12.1");
    fixture.linkTo("r1");
    fs.symlinkSync("missing", path.join(fixture.globalRoot, ".openclaw.release-link-1-2-aa"));
    fs.mkdirSync(path.join(fixture.globalRoot, ".openclaw.release-link-3-4-bb"));
    const capture = await capturePackageReleaseSlot(fixture.slot);
    if (capture.kind !== "link") {
      throw new Error("expected a link");
    }
    await switchPackageReleaseLink({
      slot: fixture.slot,
      expected: capture,
      target: path.relative(fixture.globalRoot, second),
      assertCurrent: current,
    });
    expect(fs.readdirSync(fixture.globalRoot).toSorted()).toEqual([
      ".openclaw.release-link-3-4-bb",
      "openclaw",
    ]);
  });

  it("adopts a plain directory as the previous release without changing its contents", async () => {
    const fixture = createPackageReleasePrefixFixture(dir);
    fixture.writePlainPackage("2026.11.3", "build-old");
    const before = await capturePackageReleaseSlot(fixture.slot);
    expect(before.kind).toBe("directory");

    const adopted = await adoptPackageReleaseSlot({
      slot: fixture.slot,
      releasePrefix: await createPackageReleasePrefix(fixture.prefix, "2026.11.3"),
      expected: before,
      assertCurrent: current,
    });

    const slot = readPackageReleaseSlotSync(fixture.slot);
    expect(slot?.releaseRoot).toBe(adopted.releaseRoot);
    // The rename keeps the directory's identity, so rollback can check it.
    expect(await readPackageReleaseIdentity(fixture.slot)).toEqual({
      ...before.release,
      path: adopted.releaseRoot,
    });
    expect(fs.readlinkSync(fixture.launcher)).toBe("../lib/node_modules/openclaw/openclaw.mjs");
    expect(fs.existsSync(path.join(fixture.slot, "openclaw.mjs"))).toBe(true);
  });

  it("keeps the leftover link when adoption can neither finish nor move the directory back", async () => {
    const fixture = createPackageReleasePrefixFixture(dir);
    fixture.writePlainPackage("2026.11.3", "build-old");
    const before = await capturePackageReleaseSlot(fixture.slot);
    const rename = fsp.rename.bind(fsp);
    let renames = 0;
    // The directory moves into releases/; every later rename fails.
    vi.spyOn(fsp, "rename").mockImplementation(async (from, to) => {
      renames += 1;
      if (renames > 1) {
        throw Object.assign(new Error("EIO: i/o error, rename"), { code: "EIO" });
      }
      await rename(from, to);
    });

    await expect(
      adoptPackageReleaseSlot({
        slot: fixture.slot,
        releasePrefix: await createPackageReleasePrefix(fixture.prefix, "2026.11.3"),
        expected: before,
        assertCurrent: current,
      }),
    ).rejects.toThrow("EIO");
    vi.restoreAllMocks();

    expect(fs.lstatSync(fixture.slot, { throwIfNoEntry: false })).toBeUndefined();
    const [leftover] = fs
      .readdirSync(fixture.globalRoot)
      .filter((name) => name.startsWith(".openclaw.release-link-"));
    expect(leftover).toBeDefined();
    // The documented recovery restores the unchanged package.
    fs.renameSync(path.join(fixture.globalRoot, leftover!), fixture.slot);
    expect(await readPackageReleaseIdentity(fixture.slot)).toMatchObject({
      identity: before.identity,
      version: "2026.11.3",
    });
  });

  it("refuses a candidate whose launcher differs before any change", async () => {
    const fixture = createPackageReleasePrefixFixture(dir);
    fixture.addRelease("r1", "2026.11.3");
    fixture.addRelease("r2", "2026.12.1");
    const releaseBin = path.join(fixture.prefix, "releases", "r2", "bin");
    fs.rmSync(path.join(releaseBin, "openclaw"));
    fs.symlinkSync(
      "../lib/node_modules/openclaw/bin/openclaw.js",
      path.join(releaseBin, "openclaw"),
    );
    await expect(assertPackageReleaseLaunchers(releaseBin, fixture.binDir)).rejects.toThrow(
      /differs from/u,
    );
    await expect(
      assertPackageReleaseLaunchers(
        path.join(fixture.prefix, "releases", "r1", "bin"),
        fixture.binDir,
      ),
    ).resolves.toBeUndefined();
  });

  it("rejects a recorded release whose content was rewritten in place", async () => {
    const fixture = createPackageReleasePrefixFixture(dir);
    const root = fixture.addRelease("r1", "2026.11.3");
    const recorded = await readPackageReleaseIdentity(root);
    await expect(assertPackageReleaseIdentity(recorded)).resolves.toBeUndefined();
    // A published updater swaps a new build into the directory behind the link.
    await fsp.writeFile(
      path.join(root, "dist", "build-info.json"),
      JSON.stringify({ buildId: "rewritten" }),
    );
    await expect(assertPackageReleaseIdentity(recorded)).rejects.toThrow(/not a rollback target/u);
  });
});
