import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { withAgentDeletion } from "../agents/agent-lifecycle-registry.js";
import { closeStateDatabaseForTest } from "../test-utils/database-cleanup.js";
import { applyClawPackageRemovals, planClawPackageRemovals } from "./package-remove.js";
import {
  packageRef,
  packageRefStore,
  trackedQualifiedSkillFixture,
} from "./package-remove.test-support.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

describe("Claw package removal during agent retirement", () => {
  it("removes an owned skill while retaining agent deletion authority", async () => {
    const current = await trackedQualifiedSkillFixture(
      tempDirs.make("openclaw-claw-skill-remove-"),
    );
    const ref = packageRef({ kind: "skill", ref: "@owner/triage", relationship: "managed" });
    const store = packageRefStore(ref);
    const decisions = await planClawPackageRemovals({ workspace: current.workspaceDir }, [ref], {
      deps: store,
    });
    const options = { path: join(tempDirs.make("claw-package-deletion-"), "state.sqlite") };
    try {
      await withAgentDeletion(
        "worker",
        async (begin) => {
          const deletion = await begin({
            agentId: "worker",
            agentDir: join(current.workspaceDir, "agent"),
            workspaceDir: current.workspaceDir,
            sessionsDir: join(current.workspaceDir, "sessions"),
          });
          const results = await applyClawPackageRemovals(decisions, {
            ...options,
            deletion,
            assertCurrent: deletion.assertCurrentHost,
            assertCurrentAsync: deletion.assertCurrentAsync,
            assertCurrentFinal: deletion.assertCurrentFinal,
            deps: store,
          });
          await deletion.assertCurrentAsync();
          await deletion.rollback();
          expect(results.packages).toMatchObject([{ action: "uninstalled" }]);
        },
        options,
      );
      const lock = JSON.parse(await readFile(current.lockPath, "utf8"));
      await expect(readFile(join(current.skillDir, "SKILL.md"))).rejects.toThrow();
      expect(lock.skills).toEqual({});
    } finally {
      await closeStateDatabaseForTest();
    }
  });
});
