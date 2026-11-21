import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  GIT_RELEASE_LAUNCHER,
  gitReleaseForwardingEntry,
  gitReleaseSlot,
  resolveGitReleasePrefix,
} from "../../infra/git-release-paths.js";
import { createGitReleaseDirs, publishGitRelease } from "../../infra/git-release.js";
import {
  capturePackageReleaseSlot,
  switchPackageReleaseLink,
} from "../../infra/package-release-slot.js";
import { createPackageReleasePrefixFixture } from "../../infra/package-release-slot.test-support.js";
import { createManagedHandoffLeaseStore } from "../../infra/update-managed-service-handoff-lease.js";
import { reserveUpdateCommandExecutorSlot } from "./update-command-executor-capabilities.js";
import {
  withUpdateCommandExecutor,
  withUpdateCommandExecutorChild,
} from "./update-command-executor.js";
import { useExecutorFixture } from "./update-command-executor.test-support.js";

const fixture = useExecutorFixture("update-release-link-", { restoreEnv: true });

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

  it("reserves the npm package a Git release install forwards from, so switching back to npm is admitted", async () => {
    const { root } = fixture();
    vi.stubEnv("OPENCLAW_STATE_DIR", path.join(root, "state"));
    const prefix = resolveGitReleasePrefix();
    const { releaseRoot } = await createGitReleaseDirs(prefix);
    fs.mkdirSync(path.join(releaseRoot, "dist"), { recursive: true });
    await publishGitRelease({ prefix, releaseRoot, trial: false });
    // What a package-to-Git switch leaves at the npm package path.
    const writePackage = (dir: string, entry: string) => {
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, "openclaw.mjs"), entry);
      return dir;
    };
    const forwarding = writePackage(
      path.join(root, "npm", "lib", "node_modules", "openclaw"),
      gitReleaseForwardingEntry(path.join(prefix, GIT_RELEASE_LAUNCHER)),
    );
    const unrelated = writePackage(
      path.join(root, "other", "lib", "node_modules", "openclaw"),
      "export {};\n",
    );
    const store = createManagedHandoffLeaseStore();
    const outcome: { forwarding?: string; unrelated?: string; otherInstall?: string } = {};

    // Another installation sharing the state directory cannot take this install's package.
    await withUpdateCommandExecutor(randomUUID(), async (executor) => {
      const fence = await executor.enter(unrelated);
      try {
        reserveUpdateCommandExecutorSlot(fence, forwarding);
      } catch (error) {
        outcome.otherInstall = (error as Error).message;
      }
    });
    await withUpdateCommandExecutor(randomUUID(), async (executor) => {
      const fence = await executor.enter(gitReleaseSlot(prefix));
      try {
        reserveUpdateCommandExecutorSlot(fence, unrelated);
      } catch (error) {
        outcome.unrelated = (error as Error).message;
      }
      reserveUpdateCommandExecutorSlot(fence, forwarding);
      outcome.forwarding = store.read(forwarding).kind;
    });

    expect(outcome.forwarding).toBe("current");
    expect(outcome.unrelated).toMatch(/does not resolve to its original installation/u);
    expect(outcome.otherInstall).toMatch(/does not resolve to its original installation/u);
  });
});
