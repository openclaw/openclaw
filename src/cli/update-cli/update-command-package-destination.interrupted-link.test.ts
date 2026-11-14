import { spawn } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  assertReliabilityForcedExit,
  waitForReliabilityWorkerExit,
} from "../../../scripts/lib/sqlite-reliability-process.js";
import { createFixtureLifetime } from "../../../test/helpers/fixture-lifetime.js";
import { stopChildProcess } from "../../../test/helpers/stop-child-process.js";
import {
  expectInstallation,
  readText,
  retain,
} from "../../infra/package-update-swap.assertions.test-support.js";
import { createLinkedPackageSwapFixture } from "../../infra/package-update-swap.test-support.js";
import { resolveRuntimeWorkerArgv } from "../../infra/runtime-worker-url.js";
import { inspectNpmGlobalDestination } from "./update-command-package-destination.js";
import * as servicePlan from "./update-command-service-plan.js";

const lifetime = createFixtureLifetime();
beforeEach(() => {
  // No managed Gateway service takes part; the checkout itself runs the update.
  vi.spyOn(servicePlan, "isGatewayServiceManagementAllowedForUpdate").mockReturnValue(false);
});
afterEach(async () => {
  try {
    await lifetime.cleanup();
  } finally {
    vi.restoreAllMocks();
  }
});

/** A dev checkout installed the way `npm link` leaves it: package link plus launcher link. */
async function createNpmLinkedCheckout() {
  const root = await fs.realpath(lifetime.createTempDir("update-interrupted-link-"));
  const fixture = await createLinkedPackageSwapFixture(root, true);
  const entrypoint = path.join(fixture.checkout, "openclaw.mjs");
  await fs.writeFile(entrypoint, "// checkout entrypoint\n");
  await fs.unlink(fixture.launcher);
  await fs.symlink("../lib/node_modules/openclaw/openclaw.mjs", fixture.launcher);
  return { ...fixture, root, entrypoint };
}

/** Runs the linked swap in a real process that dies while the package path is empty. */
async function killLinkedSwapBeforeActivation(root: string): Promise<string> {
  const worker = new URL(
    "../../infra/package-update-swap-link.process.test-support.ts",
    import.meta.url,
  );
  const child = spawn(process.execPath, [...resolveRuntimeWorkerArgv(worker), root], {
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, HOME: root, USERPROFILE: root },
  });
  const closed = once(child, "close");
  void closed.catch(() => {});
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => {
    stdout += String(chunk);
  });
  child.stderr.on("data", (chunk) => {
    stderr = (stderr + String(chunk)).slice(-8192);
  });
  try {
    const exit = await waitForReliabilityWorkerExit(
      child,
      `Linked swap child did not reach the crash cut: ${stderr}`,
    );
    await closed;
    assertReliabilityForcedExit(exit, `linked swap child: ${stderr}`);
    const cut: { backupRoot: string } = JSON.parse(stdout.trim());
    return cut.backupRoot;
  } finally {
    await lifetime.verifyCleanup(async () => {
      await stopChildProcess(child, 5_000);
      await closed;
    });
  }
}

describe.skipIf(process.platform === "win32")(
  "npm destination after an update died replacing the checkout's package link",
  () => {
    it("puts the link back and admits the checkout's next update", { timeout: 120_000 }, async () =>
      lifetime.run(async () => {
        const fixture = await createNpmLinkedCheckout();
        const inspect = () =>
          inspectNpmGlobalDestination(fixture.checkout, fixture.params.installTarget);
        expect(await inspect()).toEqual({ kind: "owned", interruptedLink: undefined });

        const backupRoot = await killLinkedSwapBeforeActivation(fixture.root);
        // The interruption itself: no package at its path, so the launcher dangles.
        await expect(fs.lstat(fixture.packageRoot)).rejects.toMatchObject({ code: "ENOENT" });
        await expect(fs.realpath(fixture.launcher)).rejects.toMatchObject({ code: "ENOENT" });
        expect((await fs.lstat(backupRoot)).ino).toBe(fixture.linkIdentity);

        expect(await inspect()).toEqual({ kind: "owned", interruptedLink: backupRoot });
        expect((await fs.lstat(fixture.packageRoot)).ino).toBe(fixture.linkIdentity);
        expect(await fs.readlink(fixture.packageRoot)).toBe(fixture.target);
        expect(await fs.realpath(fixture.launcher)).toBe(fixture.entrypoint);

        // The admitted retry is an ordinary linked swap: it activates and retires the link.
        const transaction = await retain(fixture.params);
        expect(await transaction.complete({ activationVerified: true }, () => {})).toBeUndefined();
        await expectInstallation(fixture.packageRoot, fixture.launcher, true);
        await expect(fs.lstat(backupRoot)).rejects.toMatchObject({ code: "ENOENT" });
        expect((await fs.stat(fixture.checkout)).ino).toBe(fixture.checkoutIdentity);
        expect(await readText(fixture.checkout, "operator.txt")).toBe("operator-owned checkout\n");
      }),
    );

    it("leaves a retained link to another checkout where it is", async () =>
      lifetime.run(async () => {
        const fixture = await createNpmLinkedCheckout();
        const backup = path.join(fixture.globalRoot, ".openclaw.package-backup-1-1");
        await fs.rename(fixture.packageRoot, backup);
        const otherCheckout = path.join(fixture.root, "other-checkout");
        await fs.mkdir(otherCheckout);

        expect(
          await inspectNpmGlobalDestination(otherCheckout, fixture.params.installTarget),
        ).toMatchObject({ kind: "unknown", cause: "unreadable-layout" });
        await expect(fs.lstat(fixture.packageRoot)).rejects.toMatchObject({ code: "ENOENT" });
        expect((await fs.lstat(backup)).ino).toBe(fixture.linkIdentity);
      }));

    it("reads a backup entry that vanished while it was listed as no link", async () =>
      lifetime.run(async () => {
        const fixture = await createNpmLinkedCheckout();
        const backup = path.join(fixture.globalRoot, ".openclaw.package-backup-1-1");
        await fs.rename(fixture.packageRoot, backup);
        await fs.unlink(fixture.launcher);
        const lstat = fs.lstat.bind(fs);
        vi.spyOn(fs, "lstat").mockImplementation(async (...args) => {
          if (String(args[0]) === backup) {
            // Another process removed the entry between the listing and this read.
            throw Object.assign(new Error("backup entry removed"), { code: "ENOENT" });
          }
          return lstat(...args);
        });

        expect(
          await inspectNpmGlobalDestination(fixture.checkout, fixture.params.installTarget),
        ).toEqual({ kind: "empty" });
      }));

    it("leaves a retained package directory where it is", async () =>
      lifetime.run(async () => {
        const fixture = await createNpmLinkedCheckout();
        const backup = path.join(fixture.globalRoot, ".openclaw.package-backup-1-1");
        await fs.unlink(fixture.packageRoot);
        await fs.rename(fixture.checkout, backup);

        // Even the directory the update runs from is not moved into the package path.
        expect(
          await inspectNpmGlobalDestination(backup, fixture.params.installTarget),
        ).toMatchObject({ kind: "unknown", cause: "unreadable-layout" });
        await expect(fs.lstat(fixture.packageRoot)).rejects.toMatchObject({ code: "ENOENT" });
        expect((await fs.stat(backup)).ino).toBe(fixture.checkoutIdentity);
      }));
  },
);
