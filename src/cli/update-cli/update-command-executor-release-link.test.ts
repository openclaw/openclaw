import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  capturePackageReleaseSlot,
  switchPackageReleaseLink,
} from "../../infra/package-release-slot.js";
import { createPackageReleasePrefixFixture } from "../../infra/package-release-slot.test-support.js";
import { createManagedHandoffLeaseStore } from "../../infra/update-managed-service-handoff-lease.js";
import {
  captureUpdateCommandExecutorAuthority,
  reserveUpdateCommandExecutorSlot,
} from "./update-command-executor-capabilities.js";
import {
  withUpdateCommandExecutor,
  withUpdateCommandExecutorChild,
} from "./update-command-executor.js";
import { useExecutorFixture } from "./update-command-executor.test-support.js";
import { admitUpdatePackageRoot } from "./update-command-package-activation.js";

const fixture = useExecutorFixture("update-release-link-");

describe.skipIf(process.platform === "win32")("executor admission on a release link", () => {
  it("runs post-switch children under the installation's lease, not the new release's", async () => {
    const { root } = fixture();
    const releases = createPackageReleasePrefixFixture(root);
    releases.addRelease("r1", "2026.11.3");
    const candidate = releases.addRelease("r2", "2026.12.1");
    releases.linkTo("r1");
    const store = createManagedHandoffLeaseStore();
    const observed: { link?: string; release?: string } = {};

    await withUpdateCommandExecutor(randomUUID(), async (executor) => {
      const fence = await executor.enter(releases.slot);
      const capture = await capturePackageReleaseSlot(releases.slot);
      if (capture.kind !== "link") {
        throw new Error("expected a link");
      }
      await switchPackageReleaseLink({
        slot: releases.slot,
        expected: capture,
        target: path.relative(releases.globalRoot, candidate),
        assertCurrent: fence.assertCurrent,
      });
      // Post-core work runs from the activated root, which is the link.
      await withUpdateCommandExecutorChild(fence, releases.slot, async (_grant, bindChild) => {
        const child = spawn(process.execPath, ["-e", "process.stdin.resume()"], {
          stdio: ["pipe", "ignore", "ignore"],
        });
        const exited = once(child, "exit");
        await once(child, "spawn");
        bindChild(child.pid!, child.spawnargs);
        observed.link = store.read(releases.slot).kind;
        observed.release = store.read(candidate).kind;
        child.stdin.end();
        await exited;
      });
    });

    expect(observed).toEqual({ link: "current", release: "absent" });
  });

  it("reserves the selected release by its real path as the installation, and refuses a deselected one", async () => {
    const { root } = fixture();
    const releases = createPackageReleasePrefixFixture(root);
    const selected = releases.addRelease("r1", "2026.11.3");
    const deselected = releases.addRelease("r2", "2026.10.9");
    releases.linkTo("r1");
    const store = createManagedHandoffLeaseStore();
    const outcome: { deselected?: string; releaseLease?: string } = {};

    await withUpdateCommandExecutor(randomUUID(), async (executor) => {
      const fence = await executor.enter(releases.slot);
      // An update that replaces the selected release in place reserves it by its real path.
      reserveUpdateCommandExecutorSlot(fence, selected);
      outcome.releaseLease = store.read(selected).kind;
      try {
        reserveUpdateCommandExecutorSlot(fence, deselected);
      } catch (error) {
        outcome.deselected = (error as Error).message;
      }
    });

    expect(outcome.releaseLease).toBe("absent");
    expect(outcome.deselected).toMatch(/does not resolve to its original installation/u);
  });

  it("keys a switch from a Git release to npm by the package destination, even before npm has a copy", async () => {
    const { root } = fixture();
    // `<state>/git-install/openclaw -> releases/<id>/openclaw`, as a Git release install keeps it.
    const prefix = path.join(root, "git-install");
    fs.mkdirSync(path.join(prefix, "releases", "r1", "openclaw"), { recursive: true });
    const gitSlot = path.join(prefix, "openclaw");
    fs.symlinkSync(path.join("releases", "r1", "openclaw"), gitSlot);
    // A Git install that never had an npm copy (M25 Windows: `ENOENT: realpath ...\node_modules\openclaw`).
    const globalRoot = path.join(root, "npm", "lib", "node_modules");
    fs.mkdirSync(globalRoot, { recursive: true });
    const packageRoot = path.join(globalRoot, "openclaw");
    const outcome: { gitKeyed?: string; installKey?: string } = {};

    await withUpdateCommandExecutor(randomUUID(), async (executor) => {
      const fence = await executor.enter(gitSlot);
      try {
        reserveUpdateCommandExecutorSlot(fence, packageRoot);
      } catch (error) {
        outcome.gitKeyed = (error as NodeJS.ErrnoException).code;
      }
    });
    await withUpdateCommandExecutor(randomUUID(), async (executor) => {
      await admitUpdatePackageRoot(executor, packageRoot, undefined, undefined);
      const fence = await executor.enter(packageRoot);
      reserveUpdateCommandExecutorSlot(fence, packageRoot);
      outcome.installKey = captureUpdateCommandExecutorAuthority(fence).installKey;
    });

    expect(outcome).toEqual({ gitKeyed: "ENOENT", installKey: packageRoot });
  });
});
