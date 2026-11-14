import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as durability from "./directory-durability.js";
import { readPackageReleaseSlotSync } from "./package-release-slot-path.js";
import type { PackageReleaseRecord } from "./package-release-slot.js";
import { createPackageReleasePrefixFixture } from "./package-release-slot.test-support.js";
import { stagePackageRelease } from "./package-update-release-switch.test-support.js";
import type { PackageUpdateTransaction } from "./package-update-swap-contract.js";
import { swapStagedPackageInstall } from "./package-update-swap.js";

let dir: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-release-switch-"));
});
afterEach(() => {
  vi.restoreAllMocks();
  fs.rmSync(dir, { recursive: true, force: true });
});

/** Every file under a directory with its bytes, to prove a release was not written. */
function snapshotTree(root: string): Record<string, string> {
  const files: Record<string, string> = {};
  const visit = (directory: string) => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const file = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        visit(file);
      } else {
        files[path.relative(root, file)] = fs.readFileSync(file, "base64");
      }
    }
  };
  visit(root);
  return files;
}

const selected = (slot: string) => readPackageReleaseSlotSync(slot)?.releaseRoot;
const current = () => {};

describe.skipIf(process.platform === "win32")("package release switch", () => {
  it("records both releases before repointing the link, and never writes the previous one", async () => {
    const fixture = createPackageReleasePrefixFixture(dir);
    const previous = fixture.addRelease("r1", "2026.11.3");
    fixture.linkTo("r1");
    const before = snapshotTree(previous);
    const params = await stagePackageRelease(fixture, "2026.12.1");
    const records: { record: PackageReleaseRecord; selectedAtRecord?: string }[] = [];
    const order: string[] = [];
    let stoppedWhileOld = false;

    const result = await swapStagedPackageInstall({
      ...params,
      assertCurrent: current,
      beforeActivate: async () => {
        order.push("stop");
        stoppedWhileOld = selected(fixture.slot) === previous;
      },
      onPackageRelease: (record) => {
        order.push("record");
        records.push({ record, selectedAtRecord: selected(fixture.slot) });
      },
      // Database rollback compares against the transaction's capture; the record precedes it.
      onTransaction: () => {
        order.push("capture");
      },
    });

    expect(result.status).toBe("committed");
    // The updater's result root is the stable package path, not a release path.
    expect(result.activePackageRoot).toBe(fixture.slot);
    expect(selected(fixture.slot)).toBe(params.stage.packageRoot);
    expect(stoppedWhileOld).toBe(true);
    expect(order).toEqual(["stop", "record", "capture"]);
    expect(records).toEqual([
      {
        record: {
          slot: fixture.slot,
          from: expect.objectContaining({ path: previous, version: "2026.11.3" }),
          to: expect.objectContaining({ path: params.stage.packageRoot, version: "2026.12.1" }),
        },
        selectedAtRecord: previous,
      },
    ]);
    expect(snapshotTree(previous)).toEqual(before);
    expect(fs.readlinkSync(fixture.launcher)).toBe("../lib/node_modules/openclaw/openclaw.mjs");
    expect(fs.readdirSync(fixture.globalRoot)).toEqual(["openclaw"]);
  });

  it("rolls the link back to the recorded previous release", async () => {
    const fixture = createPackageReleasePrefixFixture(dir);
    const previous = fixture.addRelease("r1", "2026.11.3");
    fixture.linkTo("r1");
    const params = await stagePackageRelease(fixture, "2026.12.1");
    let transaction: PackageUpdateTransaction | undefined;
    await swapStagedPackageInstall({
      ...params,
      onTransaction: (retained) => {
        transaction = retained;
      },
    });
    expect(selected(fixture.slot)).toBe(params.stage.packageRoot);

    const rollback = await transaction!.rollback(current);
    expect(rollback.exitCode).toBe(0);
    expect(rollback.activePackageRoot).toBe(fixture.slot);
    expect(selected(fixture.slot)).toBe(previous);
    expect(await transaction!.complete({ activationVerified: false }, current)).toBeUndefined();
    // The rejected candidate stays for collection; nothing deleted it in the window.
    expect(fs.existsSync(params.stage.packageRoot)).toBe(true);
  });

  it("points the link back when the switch fails after its rename", async () => {
    const fixture = createPackageReleasePrefixFixture(dir);
    const previous = fixture.addRelease("r1", "2026.11.3");
    fixture.linkTo("r1");
    const params = await stagePackageRelease(fixture, "2026.12.1");
    const sync = durability.syncDirectoryIfSupported;
    let calls = 0;
    // The temporary link is synced, then the directory after the rename; fail the second.
    vi.spyOn(durability, "syncDirectoryIfSupported").mockImplementation(async (directory) => {
      calls += 1;
      if (calls === 2) {
        throw Object.assign(new Error("EIO: i/o error, fsync"), { code: "EIO" });
      }
      return await sync(directory);
    });
    let transaction: PackageUpdateTransaction | undefined;

    const result = await swapStagedPackageInstall({
      ...params,
      onTransaction: (retained) => {
        transaction = retained;
      },
    });
    expect(result.status).toBe("failed");
    // The rename happened, so the link names the candidate despite the failure.
    expect(selected(fixture.slot)).toBe(params.stage.packageRoot);
    vi.restoreAllMocks();

    const rollback = await transaction!.rollback(current);
    expect(rollback.exitCode).toBe(0);
    expect(selected(fixture.slot)).toBe(previous);
  });

  it("refuses rollback to a previous release that was rewritten in place", async () => {
    const fixture = createPackageReleasePrefixFixture(dir);
    const previous = fixture.addRelease("r1", "2026.11.3");
    fixture.linkTo("r1");
    const params = await stagePackageRelease(fixture, "2026.12.1");
    let transaction: PackageUpdateTransaction | undefined;
    await swapStagedPackageInstall({
      ...params,
      onTransaction: (retained) => {
        transaction = retained;
      },
    });
    // A published updater swapped another build into the directory behind the old link.
    fs.writeFileSync(
      path.join(previous, "dist", "build-info.json"),
      JSON.stringify({ buildId: "x" }),
    );

    const rollback = await transaction!.rollback(current);
    expect(rollback.exitCode).toBe(1);
    expect(rollback.stderrTail).toMatch(/not a rollback target/u);
    expect(selected(fixture.slot)).toBe(params.stage.packageRoot);
    expect((await transaction!.complete({ activationVerified: false }, current))?.exitCode).toBe(1);
  });

  it("adopts a plain package directory as the previous release, then switches", async () => {
    const fixture = createPackageReleasePrefixFixture(dir);
    fixture.writePlainPackage("2026.11.3", "build-old");
    const oldIdentity = fs.statSync(fixture.slot);
    const params = await stagePackageRelease(fixture, "2026.12.1");
    let record: PackageReleaseRecord | undefined;
    let transaction: PackageUpdateTransaction | undefined;

    const result = await swapStagedPackageInstall({
      ...params,
      onPackageRelease: (value) => {
        record = value;
      },
      onTransaction: (retained) => {
        transaction = retained;
      },
    });

    expect(result.status).toBe("committed");
    expect(record?.adoption).toBe(true);
    expect(selected(fixture.slot)).toBe(params.stage.packageRoot);
    const adopted = fs.statSync(record!.from.path);
    expect([adopted.dev, adopted.ino]).toEqual([oldIdentity.dev, oldIdentity.ino]);

    expect((await transaction!.rollback(current)).exitCode).toBe(0);
    // Rollback keeps the adopted layout: the link names the old tree in its release.
    expect(selected(fixture.slot)).toBe(record!.from.path);
    expect(
      JSON.parse(fs.readFileSync(path.join(fixture.slot, "package.json"), "utf8")),
    ).toMatchObject({ version: "2026.11.3" });
  });

  it("keeps a plain directory restorable when adoption is refused after the service stop", async () => {
    const fixture = createPackageReleasePrefixFixture(dir);
    fixture.writePlainPackage("2026.11.3", "build-old");
    const params = await stagePackageRelease(fixture, "2026.12.1");
    let transaction: PackageUpdateTransaction | undefined;
    let owned = true;

    const result = await swapStagedPackageInstall({
      ...params,
      assertCurrent: () => {
        if (!owned) {
          throw new Error("lease lost");
        }
      },
      // Ownership is lost while the Gateway stops, before adoption moves anything.
      beforeActivate: async () => {
        owned = false;
      },
      onTransaction: (retained) => {
        transaction = retained;
      },
    });

    expect(result.status).toBe("failed");
    expect(fs.lstatSync(fixture.slot).isDirectory()).toBe(true);
    owned = true;
    const rollback = await transaction!.rollback(current);
    expect(rollback.exitCode).toBe(0);
    expect(fs.lstatSync(fixture.slot).isDirectory()).toBe(true);
    // The prefix allocated for adoption held nothing and is gone.
    expect(fs.readdirSync(path.join(fixture.prefix, "releases"))).toEqual([
      path.basename(params.stage.prefix),
    ]);
  });

  it("refuses a candidate with a different launcher before stopping anything", async () => {
    const fixture = createPackageReleasePrefixFixture(dir);
    const previous = fixture.addRelease("r1", "2026.11.3");
    fixture.linkTo("r1");
    const params = await stagePackageRelease(fixture, "2026.12.1");
    const launcher = path.join(params.stage.layout.binDir, "openclaw");
    fs.rmSync(launcher);
    fs.symlinkSync("../lib/node_modules/openclaw/bin/run.js", launcher);
    let stopped = false;

    const result = await swapStagedPackageInstall({
      ...params,
      beforeActivate: async () => {
        stopped = true;
      },
    });

    expect(result.status).toBe("failed");
    expect(result.step.stderrTail).toMatch(/differs from/u);
    expect(stopped).toBe(false);
    expect(selected(fixture.slot)).toBe(previous);
  });

  it("points the link back when verification fails without a retained transaction", async () => {
    const fixture = createPackageReleasePrefixFixture(dir);
    const previous = fixture.addRelease("r1", "2026.11.3");
    fixture.linkTo("r1");
    const params = await stagePackageRelease(fixture, "2026.12.1");

    const result = await swapStagedPackageInstall({
      ...params,
      postVerifyStep: async (root) => ({
        name: "doctor",
        command: "doctor",
        cwd: root,
        durationMs: 0,
        exitCode: 1,
        stderrTail: "doctor failed",
      }),
    });

    expect(result.status).toBe("failed");
    expect(result.status === "failed" && result.packageRollbackVerified).toBe(true);
    expect(selected(fixture.slot)).toBe(previous);
  });
});
