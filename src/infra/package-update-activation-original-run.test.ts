import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { withUpdateCommandExecutor } from "../cli/update-cli/update-command-executor.js";
import { openPackageActivationJournal } from "./package-update-activation-journal.js";
import { createPackageActivationLifetimeFixture } from "./package-update-activation-lifetime.test-support.js";
import { reconcileOriginalRunPackagePublication } from "./package-update-activation-original-run.js";
import { createPublicationOwner } from "./package-update-publication-owner.js";

const fixtures = createPackageActivationLifetimeFixture();
beforeEach(() => {
  fixtures.setup();
});
afterEach(async () => {
  try {
    await fixtures.lifetime.cleanup();
  } finally {
    vi.restoreAllMocks();
  }
});
async function fixture() {
  const f = await fixtures.prepare();
  const journal = openPackageActivationJournal(f.anchor);
  const original = journal.read();
  const { owner: originalNativeOwner, ...nativeAuthority } = original.descriptor.authority;
  const runId = randomUUID();
  const retained = {
    binding: {
      protocol: 1 as const,
      runId,
      planDigest: "a".repeat(64),
      targetArtifactId: "target",
      installationKey: f.packageRoot,
      stateRootKey: f.packageRoot,
    },
    nativeAuthority,
    originalNativeOwner,
  };
  const admitted = <T>(
    operation: (input: Parameters<typeof reconcileOriginalRunPackagePublication>[0]) => Promise<T>,
  ) =>
    withUpdateCommandExecutor(
      runId,
      async (executor) => {
        const fence = await executor.enter(f.packageRoot);
        return await operation({
          fence,
          retained,
          operationId: f.operationId,
          expectedCandidate: original.descriptor.candidate,
        });
      },
      { existingAuthority: nativeAuthority },
    );
  return { ...f, journal, original, retained, admitted };
}
describe.skipIf(process.platform === "win32")(
  "original-run publication under already admitted native custody",
  () => {
    it("reconciles current target idempotently, preserves evidence, and completes only on explicit verified activation", async () => {
      const f = await fixture();
      await f.admitted(async (input) => {
        const owner = createPublicationOwner(f.anchor, f.journal, input.fence.assertCurrent);
        await owner.publish(false);
        const before = f.journal.read();
        const resumed = await reconcileOriginalRunPackagePublication(input);
        expect(resumed.status.phase).toBe("publication-complete");
        expect(f.journal.read().descriptor).toEqual(before.descriptor);
        expect(f.journal.read().descriptor.authority.owner).toBe(f.retained.originalNativeOwner);
        await expect(resumed.transaction.rollback(input.fence.assertCurrent)).rejects.toThrow(
          "preserves current package",
        );
        await expect(
          resumed.transaction.complete({ activationVerified: false }, input.fence.assertCurrent),
        ).rejects.toThrow("must remain");
        expect(f.journal.read().phase).toBe("publication-complete");
        await resumed.transaction.complete({ activationVerified: true }, input.fence.assertCurrent);
        await resumed.transaction.complete({ activationVerified: true }, input.fence.assertCurrent);
        await expect(fs.stat(f.anchor)).rejects.toMatchObject({ code: "ENOENT" });
      });
    });
    it("preserves untouched preparation rather than replaying or returning target completion", async () => {
      const f = await fixture();
      const before = f.journal.read();
      await f.admitted(async (input) => {
        await expect(reconcileOriginalRunPackagePublication(input)).rejects.toThrow("untouched");
        expect(f.journal.read()).toEqual(before);
      });
    });
    it("progresses only the original prepared candidate after explicit original-owner prerequisite admission", async () => {
      const f = await fixture();
      await f.admitted(async (input) => {
        let displaced = false;
        const resumed = await reconcileOriginalRunPackagePublication({
          ...input,
          continuePreparation: true,
          onDisplaced: async () => {
            input.fence.assertCurrent();
            displaced = true;
            expect(await fs.stat(f.packageRoot).catch(() => null)).toBeNull();
          },
        });
        expect(displaced).toBe(true);
        expect(resumed.status.phase).toBe("publication-complete");
        expect(f.journal.read().descriptor).toEqual(f.original.descriptor);
      });
    });
    it.each(["retiring", "complete"] as const)(
      "reconciles candidate %s without publishing again or selecting previous",
      async (phase) => {
        const f = await fixture();
        await f.admitted(async (input) => {
          const owner = createPublicationOwner(f.anchor, f.journal, input.fence.assertCurrent);
          await owner.publish(false);
          if (phase === "retiring") {
            f.journal.transition(
              f.journal.read(),
              "retiring",
              { kind: "retire", selected: "candidate" },
              input.fence.assertCurrent,
            );
          } else {
            await owner.retire();
          }
          const publishedRoot = await fs.stat(f.packageRoot);
          const resumed = await reconcileOriginalRunPackagePublication(input);
          await expect(
            resumed.transaction.complete({ activationVerified: false }, input.fence.assertCurrent),
          ).rejects.toThrow("must remain");
          await resumed.transaction.complete(
            { activationVerified: true },
            input.fence.assertCurrent,
          );
          expect((await fs.stat(f.packageRoot)).ino).toBe(publishedRoot.ino);
          expect(f.journal.read().descriptor).toEqual(f.original.descriptor);
          await expect(fs.stat(f.anchor)).rejects.toMatchObject({ code: "ENOENT" });
        });
      },
    );
    it.each(["original-owner", "native-store", "candidate", "operation", "run"] as const)(
      "refuses wrong %s without altering original publication",
      async (defect) => {
        const f = await fixture();
        const before = f.journal.read();
        await f.admitted(async (input) => {
          switch (defect) {
            case "original-owner":
              input.retained = { ...input.retained, originalNativeOwner: "foreign-owner" };
              break;
            case "native-store":
              input.retained = {
                ...input.retained,
                nativeAuthority: { ...input.retained.nativeAuthority, databaseIdentity: "0:0" },
              };
              break;
            case "candidate":
              input.expectedCandidate = { ...input.expectedCandidate, digest: "b".repeat(64) };
              break;
            case "operation":
              input.operationId = randomUUID();
              break;
            case "run":
              input.retained = {
                ...input.retained,
                binding: { ...input.retained.binding, runId: randomUUID() },
              };
              break;
          }
          await expect(reconcileOriginalRunPackagePublication(input)).rejects.toThrow();
          expect(f.journal.read()).toEqual(before);
        });
      },
    );
    it.each(["rollback-in-progress", "retiring"] as const)(
      "refuses disarmed %s journal without package effects",
      async (phase) => {
        const f = await fixture();
        await f.admitted(async (input) => {
          f.journal.transition(f.journal.read(), phase, null, input.fence.assertCurrent);
          const before = f.journal.read();
          await expect(reconcileOriginalRunPackagePublication(input)).rejects.toThrow(
            phase === "retiring" ? "did not select the authenticated candidate" : "disarmed",
          );
          expect(f.journal.read()).toEqual(before);
        });
      },
    );
  },
);
