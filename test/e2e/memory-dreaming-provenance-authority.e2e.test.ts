import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { seedHistoricalDailyMemorySignals } from "../../extensions/memory-core/src/dreaming-phases.js";
import { rankShortTermPromotionCandidates } from "../../extensions/memory-core/src/short-term-promotion.js";
import {
  applyShortTermPromotionsForTests,
  configureMemoryCoreDreamingStateForTests,
  resetMemoryCoreDreamingStateForTests,
} from "../../extensions/memory-core/src/test-helpers.js";
import {
  readMemoryArtifactProvenance,
  recordMemoryArtifactWriteProvenance,
  replaceMemoryArtifactFileWithProvenance,
} from "../../src/memory/memory-artifact-provenance.js";
import { resetPluginStateStoreForTests } from "../../src/plugin-state/plugin-state-store.js";
import { withStateDirEnv } from "../../src/test-helpers/state-dir-env.js";

const nowMs = Date.parse("2026-08-20T12:00:00.000Z");

async function restartMemoryState(): Promise<void> {
  resetMemoryCoreDreamingStateForTests();
  resetPluginStateStoreForTests();
  await configureMemoryCoreDreamingStateForTests();
}

afterEach(() => {
  resetMemoryCoreDreamingStateForTests();
  resetPluginStateStoreForTests();
});

describe("memory dreaming provenance authority chain", () => {
  it("preserves legacy trust across restart and blocks a later uncommitted quarantine", async () => {
    await withStateDirEnv("openclaw-memory-authority-", async ({ tempRoot }) => {
      await configureMemoryCoreDreamingStateForTests();

      const legacyWorkspace = path.join(tempRoot, "legacy-workspace");
      const legacyRelativePath = "memory/2026-08-20.md";
      const legacyPath = path.join(legacyWorkspace, legacyRelativePath);
      const legacyBefore = [
        "## Project",
        "",
        "## Light Sleep",
        "<!-- openclaw:dreaming:light:start -->",
        "- Candidate: Old managed summary.",
        "<!-- openclaw:dreaming:light:end -->",
        "",
        "- Keep the handwritten customer promise after restart.",
        "",
      ].join("\n");
      const legacyAfter = legacyBefore.replace("Old managed summary", "New managed summary");
      await fs.mkdir(path.dirname(legacyPath), { recursive: true });
      await fs.writeFile(legacyPath, legacyBefore, "utf8");
      await replaceMemoryArtifactFileWithProvenance({
        workspaceDir: legacyWorkspace,
        relativePath: legacyRelativePath,
        expectedContentBefore: legacyBefore,
        contentAfter: legacyAfter,
        observedAt: nowMs - 1_000,
      });

      await restartMemoryState();
      await seedHistoricalDailyMemorySignals({
        workspaceDir: legacyWorkspace,
        filePaths: [legacyPath],
        limit: 20,
        nowMs,
        timezone: "UTC",
      });
      const legacyCandidates = await rankShortTermPromotionCandidates({
        workspaceDir: legacyWorkspace,
        minScore: 0,
        minRecallCount: 0,
        minUniqueQueries: 0,
        nowMs,
      });
      const legacyCandidate = legacyCandidates.find((candidate) =>
        candidate.snippet.includes("handwritten customer promise"),
      );
      expect(legacyCandidate?.provenance?.originClass).toBe("agent");
      if (!legacyCandidate) {
        throw new Error("expected trusted legacy candidate");
      }
      const legacyApplied = await applyShortTermPromotionsForTests({
        workspaceDir: legacyWorkspace,
        candidates: [legacyCandidate],
        minScore: 0,
        minRecallCount: 0,
        minUniqueQueries: 0,
        nowMs,
      });
      expect(legacyApplied).toMatchObject({ applied: 1, appended: 1 });
      await expect(fs.readFile(path.join(legacyWorkspace, "MEMORY.md"), "utf8")).resolves.toContain(
        "handwritten customer promise",
      );

      const lateWorkspace = path.join(tempRoot, "late-quarantine-workspace");
      const lateRelativePath = "memory/2026-08-20.md";
      const latePath = path.join(lateWorkspace, lateRelativePath);
      const trustedContent = "## Project\n\n- Keep the deployment promise after review.\n";
      await fs.mkdir(path.dirname(latePath), { recursive: true });
      await fs.writeFile(latePath, trustedContent, "utf8");
      await recordMemoryArtifactWriteProvenance({
        workspaceDir: lateWorkspace,
        relativePath: lateRelativePath,
        contentBefore: "",
        contentAfter: trustedContent,
        originClass: "agent",
        observedAt: nowMs - 2_000,
      });
      await seedHistoricalDailyMemorySignals({
        workspaceDir: lateWorkspace,
        filePaths: [latePath],
        limit: 20,
        nowMs,
        timezone: "UTC",
      });
      const lateCandidates = await rankShortTermPromotionCandidates({
        workspaceDir: lateWorkspace,
        minScore: 0,
        minRecallCount: 0,
        minUniqueQueries: 0,
        nowMs,
      });
      const lateCandidate = lateCandidates.find((candidate) =>
        candidate.snippet.includes("deployment promise"),
      );
      expect(lateCandidate?.provenance?.originClass).toBe("agent");
      if (!lateCandidate) {
        throw new Error("expected trusted candidate before quarantine reservation");
      }

      const logger = { info: () => {}, warn: () => {} };
      const appliedAfterReservation = await applyShortTermPromotionsForTests({
        workspaceDir: lateWorkspace,
        candidates: [lateCandidate],
        minScore: 0,
        minRecallCount: 0,
        minUniqueQueries: 0,
        nowMs,
        consolidation: {
          logger,
          subagent: {
            complete: async () => {
              await recordMemoryArtifactWriteProvenance({
                workspaceDir: lateWorkspace,
                relativePath: lateRelativePath,
                contentBefore: trustedContent,
                contentAfter: `${trustedContent}- Reserved quarantined append.\n`,
                originClass: "untrusted",
                observedAt: nowMs + 1_000,
              });
              return { text: "{}" };
            },
          },
        },
      });
      expect(appliedAfterReservation).toMatchObject({ applied: 0, appended: 0 });
      await expect(
        fs.readFile(path.join(lateWorkspace, "MEMORY.md"), "utf8"),
      ).rejects.toMatchObject({ code: "ENOENT" });

      await restartMemoryState();
      await expect(
        readMemoryArtifactProvenance({
          workspaceDir: lateWorkspace,
          relativePath: lateRelativePath,
        }),
      ).resolves.toMatchObject({ originClass: "untrusted" });
    });
  });
});
