import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { awaitGateBeforeSettlement, createDeferred } from "../../../test/helpers/promise.js";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { captureSandboxStateOwner } from "../../agents/sandbox/state-owner.js";
import { acquireGatewayStateOwner } from "../../infra/gateway-state-owner.js";
import { resolveOpenClawStateSqlitePath } from "../../state/openclaw-state-db.paths.js";
import { withEnvAsync } from "../../test-utils/env.js";
import { nodeFilePath } from "../../test-utils/node-file-path.js";
import { syncWorkspaceSkills } from "./workspace-skill-sync.runtime.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

it("rejects released hosted custody before changing skills after an awaited directory read", async () => {
  const sourceWorkspace = tempDirs.make("skill-sync-owner-source-");
  const targetWorkspace = tempDirs.make("skill-sync-owner-target-");
  const targetSkills = path.join(targetWorkspace, "skills");
  await fs.writeFile(targetSkills, "preserve-existing-entry");
  await withEnvAsync({ OPENCLAW_STATE_DIR: sourceWorkspace }, async () => {
    const owner = acquireGatewayStateOwner({
      databasePath: resolveOpenClawStateSqlitePath(),
      payload: {
        pid: process.pid,
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
      if (nodeFilePath(args[0]) === targetSkills) {
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
      expect(await fs.readFile(targetSkills, "utf8")).toBe("preserve-existing-entry");
      expect(result).toMatchObject({ code: "GATEWAY_STATE_OWNER_REQUIRED" });
    } finally {
      resume.resolve();
      await preparation.catch(() => {});
      read.mockRestore();
      owner.release();
    }
  });
});
