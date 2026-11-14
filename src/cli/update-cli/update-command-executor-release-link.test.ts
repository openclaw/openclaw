import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  capturePackageReleaseSlot,
  switchPackageReleaseLink,
} from "../../infra/package-release-slot.js";
import { createPackageReleasePrefixFixture } from "../../infra/package-release-slot.test-support.js";
import { createManagedHandoffLeaseStore } from "../../infra/update-managed-service-handoff-lease.js";
import {
  withUpdateCommandExecutor,
  withUpdateCommandExecutorChild,
} from "./update-command-executor.js";
import { useExecutorFixture } from "./update-command-executor.test-support.js";

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
});
