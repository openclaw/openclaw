import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { withUpdateCommandExecutor } from "../cli/update-cli/update-command-executor.js";
import {
  openPackageActivationJournal,
  resolvePackageActivationAnchor,
  resolvePackageActivationControl,
  resolvePackageActivationHelper,
} from "./package-update-activation-journal.js";
import { createPackageActivationLifetimeFixture } from "./package-update-activation-lifetime.test-support.js";
import { packageActivationRuntimeForTest } from "./package-update-activation-runtime.test-support.js";
import {
  assertNoPendingPackageActivation,
  settlePendingPackageActivation,
} from "./package-update-activation.js";
import { writePackageRoot } from "./package-update-steps.test-support.js";
import type { PackageUpdateTransaction } from "./package-update-swap-contract.js";
import { swapStagedPackageInstall } from "./package-update-swap.js";
import { createPackageSwapFixture } from "./package-update-swap.test-support.js";

const fixtures = createPackageActivationLifetimeFixture();
let root: string;
beforeEach(() => {
  ({ root } = fixtures.setup());
});
afterEach(async () => {
  try {
    await fixtures.lifetime.cleanup();
  } finally {
    vi.restoreAllMocks();
  }
});

describe.skipIf(process.platform === "win32")("verified package cleanup", () => {
  it.each(["helper", "candidate"] as const)(
    "preserves damaged unused %s while settling an unpublished preparation",
    async (changed) => {
      const f = await fixtures.prepare();
      const manifest = fs.readFileSync(path.join(f.packageRoot, "package.json"));
      const launcher = fs.readFileSync(f.launcher);
      const evidence = changed === "helper" ? "control/recovery.mjs" : "candidate/note.txt";
      fs.writeFileSync(
        changed === "helper"
          ? resolvePackageActivationHelper(f.anchor)
          : path.join(f.anchor, evidence),
        "preserved unused evidence",
      );
      const reported = vi.fn().mockImplementationOnce(() => {
        throw new Error("reporting interrupted before archival");
      });
      await expect(settlePendingPackageActivation(f.packageRoot, reported)).rejects.toThrow(
        "reporting interrupted before archival",
      );
      expect(openPackageActivationJournal(f.anchor).read()).toMatchObject({
        phase: "superseded",
        intent: { settled: true },
      });
      expect(reported).toHaveBeenCalledWith(
        expect.objectContaining({
          reason: "publication-not-started",
        }),
      );
      await expect(settlePendingPackageActivation(f.packageRoot, reported)).resolves.toMatchObject({
        reason: "publication-settled-external-change",
        retained: `${f.anchor}.superseded-${f.operationId}`,
      });
      expect(reported).toHaveBeenCalledTimes(2);
      expect(fs.readFileSync(path.join(f.packageRoot, "package.json"))).toEqual(manifest);
      expect(fs.readFileSync(f.launcher)).toEqual(launcher);
      expect(fs.readFileSync(`${f.anchor}.superseded-${f.operationId}/${evidence}`, "utf8")).toBe(
        "preserved unused evidence",
      );
      expect(() => assertNoPendingPackageActivation(f.packageRoot)).not.toThrow();
      const next = await fixtures.prepare();
      expect(next.operationId).not.toBe(f.operationId);
    },
  );

  it.each(["previous root", "helper", "unknown artifact"])(
    "preserves changed %s without blocking after verified transaction completion",
    async (changed) => {
      const f = await createPackageSwapFixture(root);
      await fixtures.writePostCoreCapability(f.params.stage.packageRoot);
      await withUpdateCommandExecutor(randomUUID(), async (executor) => {
        const fence = await executor.enter(f.packageRoot);
        let transaction: PackageUpdateTransaction | undefined;
        const result = await swapStagedPackageInstall({
          ...f.params,
          activation: { fence, runtime: packageActivationRuntimeForTest(), onPrepared: () => {} },
          onTransaction: (issued) => {
            transaction = issued;
          },
        });
        expect(result.status, result.step.stderrTail ?? "").toBe("committed");
        const anchor = resolvePackageActivationAnchor(f.packageRoot);
        const record = openPackageActivationJournal(anchor).read();
        let preserved: string;
        if (changed === "previous root") {
          fs.renameSync(path.join(anchor, "previous"), path.join(root, "original-previous"));
          fs.mkdirSync(path.join(anchor, "previous"));
          preserved = "previous/foreign.txt";
          fs.writeFileSync(path.join(anchor, preserved), "preserved bytes");
        } else if (changed === "helper") {
          preserved = "control/recovery.mjs";
          fs.writeFileSync(resolvePackageActivationHelper(anchor), "preserved bytes");
        } else {
          preserved = "operator-note.txt";
          fs.writeFileSync(path.join(anchor, preserved), "preserved bytes");
        }
        expect(
          await transaction!.complete({ activationVerified: false }, fence.assertCurrent),
        ).toMatchObject({ exitCode: 1 });
        expect(() => assertNoPendingPackageActivation(f.packageRoot)).toThrow();
        const completion = await transaction!.complete(
          { activationVerified: true },
          fence.assertCurrent,
        );
        expect(completion).toMatchObject({
          name: "package-backup-retention",
          advisory: { kind: "recoverable-maintenance" },
        });
        const retained = `${anchor}.superseded-${record.descriptor.operationId}`;
        expect(fs.readFileSync(path.join(retained, preserved), "utf8")).toBe("preserved bytes");
        expect(() => assertNoPendingPackageActivation(f.packageRoot)).not.toThrow();
        expect(fs.readFileSync(f.launcher, "utf8")).toBe("candidate launcher\n");
        expect(await transaction!.complete({ activationVerified: true }, fence.assertCurrent)).toBe(
          completion,
        );
      });
    },
  );

  it("allows another real swap when closed evidence cannot be archived", async () => {
    const f = await createPackageSwapFixture(root);
    await fixtures.writePostCoreCapability(f.params.stage.packageRoot);
    await withUpdateCommandExecutor(randomUUID(), async (executor) => {
      const fence = await executor.enter(f.packageRoot);
      let transaction: PackageUpdateTransaction | undefined;
      const activation = {
        fence,
        runtime: packageActivationRuntimeForTest(),
        onPrepared: () => {},
      };
      expect(
        (
          await swapStagedPackageInstall({
            ...f.params,
            activation,
            onTransaction: (issued) => {
              transaction = issued;
            },
          })
        ).status,
      ).toBe("committed");
      const anchor = resolvePackageActivationAnchor(f.packageRoot);
      const record = openPackageActivationJournal(anchor).read();
      fs.writeFileSync(path.join(anchor, "operator-note.txt"), "retained note");
      const rename = fs.renameSync.bind(fs);
      vi.spyOn(fs, "renameSync").mockImplementation((from, to) => {
        if (from === resolvePackageActivationControl(anchor)) {
          throw Object.assign(new Error("control archive denied"), { code: "EACCES" });
        }
        return rename(from, to);
      });
      expect(
        await transaction!.complete({ activationVerified: true }, fence.assertCurrent),
      ).toMatchObject({ advisory: { kind: "recoverable-maintenance" } });
      expect(() => assertNoPendingPackageActivation(f.packageRoot)).not.toThrow();
      await writePackageRoot(f.params.stage.packageRoot, "3.0.0");
      await fixtures.writePostCoreCapability(f.params.stage.packageRoot);
      let next: PackageUpdateTransaction | undefined;
      const result = await swapStagedPackageInstall({
        ...f.params,
        activation,
        onTransaction: (issued) => {
          next = issued;
        },
      });
      expect(result.status, result.step.stderrTail ?? "").toBe("committed");
      await next!.complete({ activationVerified: true }, fence.assertCurrent);
      expect(
        JSON.parse(fs.readFileSync(path.join(f.packageRoot, "package.json"), "utf8")).version,
      ).toBe("3.0.0");
      expect(
        fs.readFileSync(
          `${anchor}.superseded-${record.descriptor.operationId}/operator-note.txt`,
          "utf8",
        ),
      ).toBe("retained note");
      expect(() => assertNoPendingPackageActivation(f.packageRoot)).not.toThrow();
    });
  });
});
