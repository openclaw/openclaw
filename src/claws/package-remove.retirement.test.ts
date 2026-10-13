import { readFile, rename } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { withAgentDeletion } from "../agents/agent-lifecycle-registry.js";
import { applyClawHubSkillUninstall } from "../skills/lifecycle/clawhub-uninstall.js";
import {
  CLAW_PACKAGE_LIFECYCLE_LEASE_SCOPE,
  clawPackageLifecycleLeaseKey,
} from "../state/claw-package-lifecycle-lease-key.js";
import { openOpenClawStateDatabase } from "../state/openclaw-state-db.js";
import { closeStateDatabaseForTest } from "../test-utils/database-cleanup.js";
import { applyClawPackageRemovals, planClawPackageRemovals } from "./package-remove.js";
import {
  packageRef,
  packageRefStore,
  trackedQualifiedSkillFixture,
} from "./package-remove.test-support.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

describe("Claw package removal during agent retirement", () => {
  it.each(["owned", "before apply", "after staging"] as const)(
    "fences real skill removal under deletion when the package lease is %s",
    async (phase) => {
      const current = await trackedQualifiedSkillFixture(
        tempDirs.make("openclaw-claw-skill-remove-"),
      );
      const ref = packageRef({ kind: "skill", ref: "@owner/triage", relationship: "managed" });
      const store = packageRefStore(ref);
      const decisions = await planClawPackageRemovals({ workspace: current.workspaceDir }, [ref], {
        deps: store,
      });
      const options = { path: join(tempDirs.make("claw-package-deletion-"), "state.sqlite") };
      const database = openOpenClawStateDatabase(options);
      const takePackageLease = () => {
        const changed = database.db
          .prepare("UPDATE state_leases SET owner = ? WHERE scope = ? AND lease_key = ?")
          .run(
            "successor",
            CLAW_PACKAGE_LIFECYCLE_LEASE_SCOPE,
            clawPackageLifecycleLeaseKey({
              kind: "skill",
              source: "clawhub",
              ref: ref.ref,
              workspace: current.workspaceDir,
            }),
          );
        expect(changed.changes).toBe(1);
      };
      let retainedDir = current.skillDir;
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
              deps: {
                ...store,
                uninstallSkill: async (plan, hooks) => {
                  if (phase === "before apply") {
                    takePackageLease();
                  }
                  return await applyClawHubSkillUninstall(plan, {
                    ...hooks,
                    rename: async (from, to) => {
                      await rename(from, to);
                      retainedDir = String(to);
                      if (phase === "after staging") {
                        takePackageLease();
                      }
                    },
                  });
                },
              },
            });
            await deletion.assertCurrentAsync();
            await deletion.rollback();
            expect(results.packages).toMatchObject([
              phase === "owned"
                ? { action: "uninstalled" }
                : { action: "error", reason: expect.stringContaining("Claw package lifecycle") },
            ]);
          },
          options,
        );
        const lock = JSON.parse(await readFile(current.lockPath, "utf8"));
        if (phase === "owned") {
          await expect(readFile(join(current.skillDir, "SKILL.md"))).rejects.toThrow();
          expect(lock.skills).toEqual({});
        } else {
          await expect(readFile(join(retainedDir, "SKILL.md"), "utf8")).resolves.toContain(
            "name: triage",
          );
          expect(lock.skills.triage).toBeDefined();
          if (phase === "after staging") {
            await expect(readFile(join(current.skillDir, "SKILL.md"))).rejects.toThrow();
          }
        }
      } finally {
        await closeStateDatabaseForTest();
      }
    },
  );
});
