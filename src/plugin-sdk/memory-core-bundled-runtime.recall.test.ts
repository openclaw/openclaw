import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { expect, it } from "vitest";
import { createPluginStateKeyedStore } from "../plugin-state/plugin-state-store.js";
import { closeOpenClawStateDatabaseAsync } from "../state/openclaw-state-db-cache.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import {
  auditShortTermPromotionArtifacts,
  repairDreamingArtifacts,
  repairShortTermPromotionArtifacts,
} from "./memory-core-bundled-runtime.js";

it("prunes archived and dangling recall through the bundled Doctor facade", async () => {
  await withOpenClawTestState({ label: "bundled-recall-prune" }, async (state) => {
    const workspaceDir = state.workspaceDir;
    const sourcePath = "memory/.dreams/session-corpus/2026-10-12.txt";
    await fs.mkdir(path.dirname(path.join(workspaceDir, sourcePath)), { recursive: true });
    await fs.writeFile(path.join(workspaceDir, sourcePath), "A synthetic archive source.\n");
    const normalizedWorkspace = path.resolve(workspaceDir).replace(/\\/g, "/");
    const hash = (value: string) => createHash("sha256").update(value).digest("hex");
    const workspaceKey = hash(
      process.platform === "win32" ? normalizedWorkspace.toLowerCase() : normalizedWorkspace,
    );
    const key = "archived";
    const storedKey = `${workspaceKey}:${hash(key)}`;
    const recall = createPluginStateKeyedStore("memory-core", {
      namespace: "short-term-recall",
      maxEntries: 50_000,
    });
    const phase = createPluginStateKeyedStore("memory-core", {
      namespace: "short-term-phase-signals",
      maxEntries: 50_000,
    });
    const row = { version: 1, workspaceDir, workspaceKey, key };
    const seed = async () => {
      await recall.register(storedKey, {
        ...row,
        value: {
          key,
          path: sourcePath,
          source: "memory",
          startLine: 1,
          endLine: 1,
          snippet: "A synthetic archive source.",
          recallCount: 1,
          firstRecalledAt: "2026-10-12T00:00:00.000Z",
          lastRecalledAt: "2026-10-12T00:00:00.000Z",
        },
      });
      await phase.register(storedKey, { ...row, value: { key, lightHits: 1, remHits: 0 } });
    };
    try {
      await seed();
      await expect(repairDreamingArtifacts({ workspaceDir })).resolves.toMatchObject({
        archivedSessionCorpus: true,
        warnings: [],
      });
      expect(await recall.lookup(storedKey)).toBeUndefined();
      expect(await phase.lookup(storedKey)).toBeUndefined();

      // A crash after rename can leave the old rows for the nightly repair entry point.
      await seed();
      await expect(repairShortTermPromotionArtifacts({ workspaceDir })).resolves.toMatchObject({
        changed: true,
        removedDanglingEntries: 1,
      });
      expect(await recall.lookup(storedKey)).toBeUndefined();
      expect(await phase.lookup(storedKey)).toBeUndefined();
      await expect(auditShortTermPromotionArtifacts({ workspaceDir })).resolves.toMatchObject({
        danglingEntryCount: 0,
      });
    } finally {
      await closeOpenClawStateDatabaseAsync();
    }
  });
});
