import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import { withUpdateCommandExecutor } from "../cli/update-cli/update-command-executor.js";
import { openPackageActivationSettlementJournal } from "./package-update-activation-journal.js";
import { createPackageActivationLifetimeFixture } from "./package-update-activation-lifetime.test-support.js";
import {
  resolvePackageActivationAnchor,
  resolvePackageActivationJournalPath,
} from "./package-update-activation-paths.js";
import { packageActivationRuntimeForTest } from "./package-update-activation-runtime.test-support.js";
import {
  assertNoPendingPackageActivation,
  settlePendingPackageActivation,
} from "./package-update-activation.js";
import { writePackageRoot } from "./package-update-steps.test-support.js";
import type { PackageUpdateTransaction } from "./package-update-swap-contract.js";
import { swapStagedPackageInstall } from "./package-update-swap.js";
import { createPackageSwapFixture } from "./package-update-swap.test-support.js";
import { prepareRetainedRuntimeFiles } from "./update-retained-runtime-files.js";

const fixtures = createPackageActivationLifetimeFixture();
let root: string;
beforeEach(() => {
  ({ root } = fixtures.setup());
});
afterEach(() => fixtures.cleanup());

async function activate(f: Awaited<ReturnType<typeof createPackageSwapFixture>>) {
  await fixtures.writePostCoreCapability(f.params.stage.packageRoot);
  await withUpdateCommandExecutor(randomUUID(), async (executor) => {
    const fence = await executor.enter(f.packageRoot);
    let transaction: PackageUpdateTransaction | undefined;
    const result = await swapStagedPackageInstall({
      ...f.params,
      activation: { fence, runtime: packageActivationRuntimeForTest(), onPrepared() {} },
      onTransaction(issued) {
        transaction = issued;
      },
    });
    expect(result.status, result.step.stderrTail ?? "").toBe("committed");
    expect(
      await transaction!.complete({ activationVerified: true }, fence.assertCurrent),
    ).toBeUndefined();
  });
}

// Standalone activation recovery is POSIX-only; Windows uses ordinary package swaps.
it.skipIf(process.platform === "win32").each([false, true])(
  "completes a second swap after retention (already linked receipt=%s)",
  async (alreadyLinked) => {
    const f = await createPackageSwapFixture(root);
    await activate(f);
    const anchor = resolvePackageActivationAnchor(f.packageRoot);
    const journal = resolvePackageActivationJournalPath(anchor);
    const journalBytes = fs.readFileSync(journal);
    if (alreadyLinked) {
      // Reproduce the retained alias left by an affected installed updater.
      fs.linkSync(journal, path.join(root, "old-retention-journal"));
      const inspection = openPackageActivationSettlementJournal(anchor);
      const completed = inspection.read();
      expect(() => inspection.transition(completed, "prepared", null, () => {})).toThrow(
        "cannot admit a journal writer",
      );
    }
    const privateModule = path.join(f.packageRoot, "dist", "private-recovery.mjs");
    fs.writeFileSync(privateModule, "// retained recovery bytes\n", { mode: 0o600 });
    const before = fs.lstatSync(privateModule, { bigint: true });
    const retained = await prepareRetainedRuntimeFiles({
      privateRoot: path.join(root, "retained"),
      sourceRoot: f.packageRoot,
      roots: [path.join(f.packageRoot, "package.json"), path.join(f.packageRoot, "dist")],
      retainedDependencyRoot: f.globalRoot,
    });
    expect(retained).not.toHaveProperty("unusableReason");
    const settled = await settlePendingPackageActivation(f.packageRoot, undefined, undefined, {
      automatic: true,
    });
    if (alreadyLinked) {
      expect(settled?.warning).toContain(
        "Archived multiply linked completed package recovery evidence",
      );
      expect(fs.readFileSync(path.join(settled!.retained!, "control", "operation.sqlite"))).toEqual(
        journalBytes,
      );
      expect(fs.readFileSync(path.join(root, "old-retention-journal"))).toEqual(journalBytes);
      expect(fs.existsSync(journal)).toBe(false);
    }
    expect(fs.lstatSync(privateModule, { bigint: true })).toMatchObject({
      nlink: 1n,
      ino: before.ino,
      ctimeNs: before.ctimeNs,
    });
    expect(() => assertNoPendingPackageActivation(f.packageRoot)).not.toThrow();
    await writePackageRoot(f.params.stage.packageRoot, "3.0.0");
    fs.mkdirSync(f.params.stage.layout.binDir, { recursive: true });
    fs.writeFileSync(path.join(f.params.stage.layout.binDir, "openclaw"), "next launcher\n");
    await activate(f);
    expect(
      JSON.parse(fs.readFileSync(path.join(f.packageRoot, "package.json"), "utf8")).version,
    ).toBe("3.0.0");
  },
);

it.skipIf(process.platform === "win32")(
  "keeps multiply linked in-flight recovery blocked and preserves its bytes",
  async () => {
    const f = await fixtures.prepare();
    const journal = resolvePackageActivationJournalPath(f.anchor);
    fs.linkSync(journal, path.join(root, "untrusted-link"));
    const before = fixtures.snapshotControl(f.anchor);
    await expect(
      settlePendingPackageActivation(f.packageRoot, undefined, undefined, { automatic: true }),
    ).rejects.toThrow("expected nlink=1");
    expect(() => assertNoPendingPackageActivation(f.packageRoot)).toThrow("expected nlink=1");
    expect(fixtures.snapshotControl(f.anchor)).toEqual(before);
  },
);
