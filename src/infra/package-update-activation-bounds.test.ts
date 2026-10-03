import { randomUUID } from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { withUpdateCommandExecutor } from "../cli/update-cli/update-command-executor.js";
import {
  openPackageActivationJournal,
  resolvePackageActivationAnchor,
} from "./package-update-activation-journal.js";
import { createPackageActivationLifetimeFixture } from "./package-update-activation-lifetime.test-support.js";
import { packageActivationRuntimeForTest } from "./package-update-activation-runtime.test-support.js";
import { createPublicationOwner } from "./package-update-publication-owner.js";
import type { PackageUpdateTransaction } from "./package-update-swap-contract.js";
import { swapStagedPackageInstall } from "./package-update-swap.js";
import { createPackageSwapFixture } from "./package-update-swap.test-support.js";
import { updateRunStepsFromResultStep } from "./update-run-step.js";

const fixtures = createPackageActivationLifetimeFixture();
let root: string;
beforeEach(() => {
  ({ root } = fixtures.setup());
  const state = path.join(root, "state");
  fs.mkdirSync(state, { mode: 0o700 });
  vi.stubEnv("OPENCLAW_STATE_DIR", state);
  vi.stubEnv("OPENCLAW_CONFIG_PATH", path.join(state, "openclaw.json"));
});
afterEach(async () => {
  try {
    await fixtures.lifetime.cleanup();
  } finally {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  }
});

it.skipIf(process.platform === "win32").each(["preparation", "publication"] as const)(
  "activates after candidate byte exhaustion at %s while retaining identity, version, and launcher checks",
  (phase) =>
    fixtures.lifetime.run(async () => {
      const f = await createPackageSwapFixture(root);
      await fixtures.writePostCoreCapability(f.params.stage.packageRoot);
      const payload = "a-oversized.bin";
      await fsp.writeFile(path.join(f.params.stage.packageRoot, payload), "");
      const anchor = resolvePackageActivationAnchor(f.packageRoot);
      const oversized =
        phase === "preparation" ? f.params.stage.packageRoot : path.join(anchor, "candidate");
      const lstat = fsp.lstat.bind(fsp);
      let oversizedObserved = false;
      vi.spyOn(fsp, "lstat").mockImplementation(async (...args) => {
        const stat = await lstat(...args);
        if (
          !oversizedObserved &&
          String(args[0]) === path.join(oversized, payload) &&
          args[1]?.bigint &&
          stat.isFile()
        ) {
          // The first regular file exceeds the byte budget before any candidate hashing.
          stat.size = 8n * 1024n * 1024n * 1024n + 1n;
          oversizedObserved = true;
        }
        return stat;
      });
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
        expect(result.status, result.step.stderrTail ?? undefined).toBe("committed");
        expect(oversizedObserved).toBe(true);
        expect(result.step.advisory?.message).toContain("full package contents are unverified");
        expect(updateRunStepsFromResultStep(result.step)).toContainEqual(
          expect.objectContaining({ step: "warning:package-swap", status: "completed" }),
        );
        expect(fs.readFileSync(f.launcher, "utf8")).toBe("candidate launcher\n");
        const manifest = path.join(f.packageRoot, "package.json");
        const originalManifest = fs.readFileSync(manifest);
        expect(JSON.parse(originalManifest.toString()).version).toBe("2.0.0");
        const journal = openPackageActivationJournal(anchor);
        expect(journal.read().phase).toBe("publication-complete");

        // Reopen the real journal as recovery would; no in-process fingerprint survives.
        const owner = createPublicationOwner(anchor, journal, fence.assertCurrent);
        const retained = path.join(root, "retained-candidate");
        fs.renameSync(f.packageRoot, retained);
        fs.mkdirSync(f.packageRoot);
        fs.writeFileSync(manifest, originalManifest);
        await expect(owner.preflight("retire")).rejects.toThrow("recorded generation");
        fs.unlinkSync(manifest);
        fs.rmdirSync(f.packageRoot);
        fs.renameSync(retained, f.packageRoot);
        fs.writeFileSync(manifest, '{"name":"openclaw","version":"3.0.0"}');
        await expect(owner.preflight("retire")).rejects.toThrow(
          "Package publication object changed",
        );
        fs.writeFileSync(manifest, originalManifest);
        // Full fingerprints include manifest metadata, so only identity-only preparation
        // can reuse the repaired version after this deliberate write.
        if (phase === "preparation") {
          fs.writeFileSync(f.launcher, "changed launcher\n");
          await expect(owner.preflight("retire")).rejects.toThrow("Package launcher changed");
          fs.writeFileSync(f.launcher, "candidate launcher\n");
          await expect(owner.preflight("retire")).resolves.toBeUndefined();
          await transaction!.complete({ activationVerified: true }, fence.assertCurrent);
          expect(fs.existsSync(anchor)).toBe(false);
        }
      });
    }),
);
