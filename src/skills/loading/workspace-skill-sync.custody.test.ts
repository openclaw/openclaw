import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { awaitGateBeforeSettlement, createDeferred } from "../../../test/helpers/promise.js";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { captureSandboxStateOwner } from "../../agents/sandbox/state-owner.js";
import { readGatewayLockProcessNamespace } from "../../infra/gateway-lock-payload.js";
import { acquireGatewayStateOwner } from "../../infra/gateway-state-owner.js";
import { resolveOpenClawStateSqlitePath } from "../../state/openclaw-state-db.paths.js";
import { withEnvAsync } from "../../test-utils/env.js";
import { nodeFilePath } from "../../test-utils/node-file-path.js";
import { syncWorkspaceSkills } from "./workspace-skill-sync.runtime.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

it.each(["target", "source-directory", "source-file"])(
  "rejects released hosted custody after awaiting %s metadata",
  async (boundary) => {
    const sourceWorkspace = tempDirs.make("skill-sync-owner-source-");
    const targetWorkspace = tempDirs.make("skill-sync-owner-target-");
    const targetSkills = path.join(targetWorkspace, "skills");
    const sourceSkill = path.join(sourceWorkspace, "skills", "alpha");
    await fs.mkdir(sourceSkill, { recursive: true });
    await fs.writeFile(
      path.join(sourceSkill, "SKILL.md"),
      "---\nname: alpha\ndescription: Synthetic\n---\nSkill\n",
    );
    if (boundary === "target") {
      await fs.writeFile(targetSkills, "preserve-existing-entry");
    }
    const observedPath =
      boundary === "target"
        ? targetSkills
        : boundary === "source-directory"
          ? sourceSkill
          : path.join(sourceSkill, "SKILL.md");
    await withEnvAsync({ OPENCLAW_STATE_DIR: sourceWorkspace }, async () => {
      const owner = acquireGatewayStateOwner({
        databasePath: resolveOpenClawStateSqlitePath(),
        payload: {
          pid: process.pid,
          processNamespace: readGatewayLockProcessNamespace(),
          createdAt: new Date().toISOString(),
          configPath: path.join(sourceWorkspace, "openclaw.json"),
          role: "gateway",
        },
      });
      const assertCurrent = await captureSandboxStateOwner();
      const entered = createDeferred();
      const resume = createDeferred();
      const lstat = fs.lstat.bind(fs);
      const read = vi.spyOn(fs, "lstat").mockImplementation(async (...args) => {
        const result = await lstat(...args);
        if (nodeFilePath(args[0]) === observedPath) {
          entered.resolve();
          await resume.promise;
        }
        return result;
      });
      const preparation = syncWorkspaceSkills({
        sourceWorkspaceDir: sourceWorkspace,
        targetWorkspaceDir: targetWorkspace,
        bundledSkillsDir: path.join(sourceWorkspace, ".bundled"),
        managedSkillsDir: path.join(sourceWorkspace, ".managed"),
        config: { plugins: { enabled: false }, skills: { load: { watch: false } } },
        assertCurrent,
      });
      try {
        await awaitGateBeforeSettlement(
          entered.promise,
          preparation,
          "Skill sync skipped directory read",
        );
        owner.release();
        resume.resolve();
        const result = await preparation.catch((error: unknown) => error);
        if (boundary === "target") {
          expect(await fs.readFile(targetSkills, "utf8")).toBe("preserve-existing-entry");
        } else {
          await expect(
            fs.access(path.join(targetSkills, "alpha", "SKILL.md")),
          ).rejects.toMatchObject({ code: "ENOENT" });
        }
        expect(result).toMatchObject({ code: "GATEWAY_STATE_OWNER_REQUIRED" });
      } finally {
        resume.resolve();
        await preparation.catch(() => {});
        read.mockRestore();
        owner.release();
      }
    });
  },
);
