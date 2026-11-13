import fsSync from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { awaitGateBeforeSettlement, withinTest } from "../../../test/helpers/promise.js";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { useWorkspaceFilesystemBlock } from "../../../test/helpers/workspace-filesystem-block.js";
import { acquireSandboxGatewayOwner } from "../../agents/sandbox/registry.test-support.js";
import { captureSandboxStateOwner } from "../../agents/sandbox/state-owner.js";
import { readGatewayLockProcessNamespace } from "../../infra/gateway-lock-payload.js";
import { acquireGatewayStateOwner } from "../../infra/gateway-state-owner.js";
import { resolveOpenClawStateSqlitePath } from "../../state/openclaw-state-db.paths.js";
import { withEnvAsync } from "../../test-utils/env.js";
import * as skillsRuntime from "../runtime/refresh.js";
import { syncWorkspaceSkills } from "./workspace-skill-sync.runtime.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const filesystemBlock = useWorkspaceFilesystemBlock("mutationExists");

it("refuses mount source creation when custody retires during the worker path lookup", async ({
  signal,
}) => {
  const workspace = tempDirs.make("mount-source-retirement-");
  await withEnvAsync({ OPENCLAW_STATE_DIR: workspace }, async () => {
    using owner = acquireSandboxGatewayOwner(workspace);
    const captured = await captureSandboxStateOwner();
    const entered = filesystemBlock.arm(workspace, 1);
    const preparation = skillsRuntime.prepareSandboxMountSources(
      {
        workspaceDir: workspace,
        agentWorkspaceDir: workspace,
        workdir: "/workspace",
        workspaceAccess: "none",
      },
      captured.assertCurrent,
      captured.stateOwnerPath,
    );
    try {
      await withinTest(
        awaitGateBeforeSettlement(entered, preparation, "worker mutation path lookup"),
        signal,
      );
      owner.release();
    } finally {
      filesystemBlock.release();
    }
    await expect(preparation).rejects.toMatchObject({ code: "GATEWAY_STATE_OWNER_REQUIRED" });
    await expect(fs.access(path.join(workspace, "skills"))).rejects.toMatchObject({
      code: "ENOENT",
    });
  });
});

it.each(["target", "copy"])(
  "rejects released hosted custody at the worker %s mutation boundary",
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
      const { assertCurrent: assertOwner, stateOwnerPath } = await captureSandboxStateOwner();
      let armed = false;
      let refusal: unknown;
      const assertCurrent = () => {
        if (
          armed &&
          (boundary === "target" || fsSync.existsSync(path.join(targetSkills, "alpha")))
        ) {
          owner.release();
        }
        try {
          assertOwner();
        } catch (error) {
          refusal ??= error;
          throw error;
        }
      };
      const dispatch = skillsRuntime.syncSkillsFilesystem;
      const filesystem = vi
        .spyOn(skillsRuntime, "syncSkillsFilesystem")
        .mockImplementation((operation, assertSyncCurrent, onPhase, syncStateOwnerPath) =>
          dispatch(
            operation,
            () => {
              armed = true;
              assertSyncCurrent?.();
            },
            onPhase,
            syncStateOwnerPath,
          ),
        );
      const preparation = syncWorkspaceSkills({
        sourceWorkspaceDir: sourceWorkspace,
        targetWorkspaceDir: targetWorkspace,
        bundledSkillsDir: path.join(sourceWorkspace, ".bundled"),
        managedSkillsDir: path.join(sourceWorkspace, ".managed"),
        config: { plugins: { enabled: false }, skills: { load: { watch: false } } },
        assertCurrent,
        stateOwnerPath,
      });
      try {
        const result = await preparation.catch((error: unknown) => error);
        if (boundary === "target") {
          expect(await fs.readFile(targetSkills, "utf8")).toBe("preserve-existing-entry");
        } else {
          await expect(
            fs.access(path.join(targetSkills, "alpha", "SKILL.md")),
          ).rejects.toMatchObject({ code: "ENOENT" });
        }
        expect(result).toBe(refusal);
        expect(result).toMatchObject({ code: "GATEWAY_STATE_OWNER_REQUIRED" });
      } finally {
        await preparation.catch(() => {});
        filesystem.mockRestore();
        owner.release();
      }
    });
  },
);

it.skipIf(process.platform === "win32")(
  "refuses skill publication after its captured state alias retargets",
  async () => {
    const first = tempDirs.make("skill-sync-state-first-");
    const second = tempDirs.make("skill-sync-state-second-");
    const alias = path.join(tempDirs.make("skill-sync-state-alias-"), "selected");
    const target = tempDirs.make("skill-sync-state-target-");
    const skill = path.join(first, "skills", "alpha");
    await fs.mkdir(skill, { recursive: true });
    await fs.writeFile(
      path.join(skill, "SKILL.md"),
      "---\nname: alpha\ndescription: Synthetic\n---\nSkill\n",
    );
    await fs.symlink(first, alias, "dir");
    await withEnvAsync({ OPENCLAW_STATE_DIR: alias }, async () => {
      const owner = acquireGatewayStateOwner({
        databasePath: resolveOpenClawStateSqlitePath(),
        payload: {
          pid: process.pid,
          processNamespace: readGatewayLockProcessNamespace(),
          createdAt: new Date().toISOString(),
          configPath: path.join(alias, "openclaw.json"),
          role: "gateway",
        },
      });
      try {
        const captured = await captureSandboxStateOwner();
        await fs.unlink(alias);
        await fs.symlink(second, alias, "dir");
        await expect(
          syncWorkspaceSkills({
            sourceWorkspaceDir: first,
            targetWorkspaceDir: target,
            bundledSkillsDir: path.join(first, ".bundled"),
            managedSkillsDir: path.join(first, ".managed"),
            config: { plugins: { enabled: false }, skills: { load: { watch: false } } },
            assertCurrent: captured.assertCurrent,
            stateOwnerPath: captured.stateOwnerPath,
          }),
        ).rejects.toMatchObject({ code: "GATEWAY_STATE_OWNER_REQUIRED" });
        expect(await fs.readdir(target)).toEqual([]);
      } finally {
        owner.release();
      }
    });
  },
);
