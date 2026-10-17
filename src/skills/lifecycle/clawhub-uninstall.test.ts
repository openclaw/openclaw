import { createHash } from "node:crypto";
import fs, { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { registerAgentWorkspaceAccess } from "../../agents/workspace-access.js";
import {
  initializeGlobalHookRunner,
  resetGlobalHookRunner,
} from "../../plugins/hook-runner-global.js";
import { createMockPluginRegistry } from "../../plugins/hooks.test-fixtures.js";
import * as clawhubStore from "./clawhub-store.js";
import { untrackClawHubSkill } from "./clawhub-store.js";
import { applyClawHubSkillUninstall, planClawHubSkillUninstall } from "./clawhub-uninstall.js";
import { digestClawHubSkillTree } from "./skill-tree-digest.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
afterEach(() => resetGlobalHookRunner());

async function fixture() {
  const workspaceDir = tempDirs.make("openclaw-skill-uninstall-");
  const slug = "triage";
  const skillDir = join(workspaceDir, "skills", slug);
  const content = "---\nname: triage\ndescription: Triage incidents\nversion: 0.9.0\n---\n";
  const sha256 = createHash("sha256").update(content).digest("hex");
  const installedAt = 123;
  const registry = "https://clawhub.ai";
  const ownerHandle = "owner";
  await mkdir(join(skillDir, ".clawhub"), { recursive: true });
  await mkdir(join(workspaceDir, ".clawhub"), { recursive: true });
  await writeFile(join(skillDir, "SKILL.md"), content);
  const fileTreeSha256 = await digestClawHubSkillTree(skillDir);
  const entry = {
    version: "1.0.0",
    registry,
    installedAt,
    ownerHandle,
    skillFile: { path: "SKILL.md", sha256 },
    fileTreeSha256,
  };
  await writeFile(
    join(skillDir, ".clawhub", "origin.json"),
    JSON.stringify({ ...entry, version: 1, slug, installedVersion: entry.version }),
  );
  await writeFile(
    join(workspaceDir, ".clawhub", "lock.json"),
    JSON.stringify({ version: 1, skills: { [slug]: entry } }),
  );
  return {
    workspaceDir,
    slug,
    skillDir,
    originPath: join(skillDir, ".clawhub", "origin.json"),
    lockPath: join(workspaceDir, ".clawhub", "lock.json"),
    readSkill: () => readFile(join(skillDir, "SKILL.md"), "utf8"),
    readLock: () => readFile(join(workspaceDir, ".clawhub", "lock.json"), "utf8"),
  };
}

async function plan(current: Awaited<ReturnType<typeof fixture>>, slug = current.slug) {
  return planClawHubSkillUninstall({
    workspaceDir: current.workspaceDir,
    slug,
    expectedVersion: "1.0.0",
  });
}
async function requirePlan(current: Awaited<ReturnType<typeof fixture>>, slug = current.slug) {
  const planned = await plan(current, slug);
  if (!planned.ok) {
    throw new Error(planned.error);
  }
  return planned.plan;
}

async function replaceTrackedOwner(
  current: Awaited<ReturnType<typeof fixture>>,
  ownerHandle: string,
) {
  const origin = JSON.parse(await readFile(current.originPath, "utf8")) as {
    ownerHandle: string;
  };
  origin.ownerHandle = ownerHandle;
  await writeFile(current.originPath, JSON.stringify(origin));

  const lock = JSON.parse(await current.readLock()) as {
    skills: Record<string, { ownerHandle: string }>;
  };
  lock.skills[current.slug]!.ownerHandle = ownerHandle;
  await writeFile(current.lockPath, JSON.stringify(lock));
}

describe("ClawHub skill uninstall lifecycle", () => {
  it.each([
    { checkpoint: "apply", retracked: false },
    { checkpoint: "rollback", retracked: false },
    { checkpoint: "rollback", retracked: true },
  ])(
    "rechecks tracking after $checkpoint authorization (retracked=$retracked)",
    async ({ checkpoint, retracked }) => {
      const current = await fixture();
      const before = await current.readLock();
      const tracking = JSON.parse(before);
      const restore = await untrackClawHubSkill(
        current.workspaceDir,
        current.slug,
        undefined,
        undefined,
        async (phase) => {
          if (phase === checkpoint) {
            if (retracked) {
              await writeFile(current.lockPath, before);
            } else {
              const lock = JSON.parse(await current.readLock());
              lock.skills.sibling = tracking.skills[current.slug];
              await writeFile(current.lockPath, JSON.stringify(lock));
            }
          }
        },
      );
      if (retracked) {
        await expect(restore()).rejects.toThrow("was retracked during rollback");
        expect(await current.readLock()).toBe(before);
      } else {
        if (checkpoint === "rollback") {
          await restore();
        }
        expect(JSON.parse(await current.readLock()).skills.sibling).toEqual(
          tracking.skills[current.slug],
        );
      }
    },
  );

  it.each(["untrack", "rollback", "authorization"])(
    "fences revoked local authority after awaited %s",
    async (phase) => {
      const current = await fixture();
      let owned = true;
      const message =
        phase === "authorization" ? "superseded after authorization" : "removal superseded";
      const guard = () => {
        if (!owned) {
          throw new Error(message);
        }
      };
      const restore =
        phase === "rollback"
          ? await untrackClawHubSkill(current.workspaceDir, current.slug, guard)
          : undefined;
      const before = await current.readLock();
      const pending = restore
        ? restore()
        : untrackClawHubSkill(
            current.workspaceDir,
            current.slug,
            guard,
            undefined,
            phase === "authorization"
              ? async () => {
                  owned = false;
                }
              : undefined,
          );
      if (phase !== "authorization") {
        owned = false;
      }
      await expect(pending).rejects.toThrow(message);
      await expect(current.readLock()).resolves.toBe(before);
    },
  );

  it.each(["local", "forwarded", "forwarding-failed"])(
    "plans and removes an unchanged tracked skill with %s change delivery",
    async (delivery) => {
      const current = await fixture();
      const release =
        delivery === "local"
          ? registerAgentWorkspaceAccess(current.workspaceDir, {
              bridge: { readFile: vi.fn(), writeFile: vi.fn(), stat: vi.fn() },
            })
          : undefined;
      const requestedRef = delivery === "local" ? "@owner/triage" : current.slug;
      try {
        const handler = vi.fn();
        const onCommittedChange =
          delivery === "local"
            ? undefined
            : vi.fn(async () => {
                if (delivery === "forwarding-failed") {
                  throw new Error("change delivery disconnected");
                }
              });
        if (!onCommittedChange) {
          initializeGlobalHookRunner(
            createMockPluginRegistry([{ hookName: "skill_changed", handler }]),
          );
        }
        const removal = await requirePlan(current, requestedRef);
        expect(removal).toMatchObject({ requestedRef, slug: "triage", version: "1.0.0" });
        await expect(applyClawHubSkillUninstall(removal, { onCommittedChange })).resolves.toEqual({
          ok: true,
        });
        await expect(current.readSkill()).rejects.toMatchObject({
          code: "ENOENT",
        });
        const lock = JSON.parse(await current.readLock());
        expect(lock.skills).toEqual({});
        const delivered = onCommittedChange ?? handler;
        expect(delivered).toHaveBeenCalledTimes(1);
        expect(delivered.mock.calls[0]?.[0]).toMatchObject({
          action: "removed",
          source: "clawhub",
          before: {
            name: "triage",
            skillKey: "triage",
            description: "Triage incidents",
            source: "clawhub",
            revision: {
              declaredVersion: "0.9.0",
              sourceVersion: "1.0.0",
              contentSha256: expect.stringMatching(/^sha256:[a-f0-9]{64}$/),
              treeSha256: expect.stringMatching(/^sha256:[a-f0-9]{64}$/),
            },
          },
        });
      } finally {
        release?.();
      }
    },
  );

  it.each(["planning", "applying"])(
    "rejects a changed publisher when %s removal",
    async (phase) => {
      const current = await fixture();
      if (phase === "planning") {
        await expect(plan(current, "@other/triage")).resolves.toEqual({
          ok: false,
          code: "ambiguous",
          error: 'Skill "triage" is tracked as @owner/triage, not @other/triage.',
        });
        expect(JSON.parse(await current.readLock()).skills.triage).toBeDefined();
      } else {
        const removal = await requirePlan(current, "@owner/triage");
        await replaceTrackedOwner(current, "other");
        await expect(applyClawHubSkillUninstall(removal)).resolves.toEqual({
          ok: false,
          error: 'Skill "triage" is tracked as @other/triage, not @owner/triage.',
        });
      }
      await expect(current.readSkill()).resolves.toContain("name: triage");
    },
  );

  it.each(["SKILL.md", "script.js"])("retains a skill with local changes to %s", async (file) => {
    const current = await fixture();
    await writeFile(join(current.skillDir, file), "operator edit\n");
    await expect(plan(current)).resolves.toMatchObject({ ok: false, code: "modified" });
  });

  it.each(["parent deletion", "untracking", "remote authorization"])(
    "restores files and tracking when %s fails during removal",
    async (failure) => {
      const current = await fixture();
      const before = await current.readLock();
      const handler = vi.fn();
      if (failure === "untracking") {
        initializeGlobalHookRunner(
          createMockPluginRegistry([{ hookName: "skill_changed", handler }]),
        );
      }
      const removal = await requirePlan(current);
      let active = true;
      const phases: string[] = [];
      const message =
        failure === "parent deletion"
          ? "Parent deletion ended."
          : failure === "untracking"
            ? "lockfile write failed"
            : "parent canceled";
      const renameSpy =
        failure === "parent deletion"
          ? vi
              .spyOn(fs, "rename")
              .mockImplementation(async (...args: Parameters<typeof rename>) => {
                await rename(...args);
                active = false;
              })
          : undefined;
      const untrackSpy =
        failure === "untracking"
          ? vi.spyOn(clawhubStore, "untrackClawHubSkill").mockRejectedValueOnce(new Error(message))
          : undefined;
      const result = await applyClawHubSkillUninstall(
        removal,
        failure === "parent deletion"
          ? {
              beforePersistentApply: () => {
                if (!active) {
                  throw new Error(message);
                }
              },
            }
          : failure === "untracking"
            ? {}
            : {
                authorizeMutation: async (phase) => {
                  phases.push(phase);
                  // Revoke after untracking, immediately before deleting the staged tree.
                  if (
                    phase === "apply" &&
                    phases.filter((entry) => entry === "apply").length === 4
                  ) {
                    throw new Error(message);
                  }
                },
              },
      ).finally(() => {
        renameSpy?.mockRestore();
        untrackSpy?.mockRestore();
      });
      expect(result).toMatchObject({ ok: false, error: expect.stringContaining(message) });
      const lock = await current.readLock();
      expect(JSON.parse(lock)).toEqual(JSON.parse(before));
      expect(JSON.parse(lock).skills.triage).toBeDefined();
      const restored = await current.readSkill();
      expect(restored).toContain("name: triage");
      expect(restored).toContain("Triage incidents");
      expect(handler).not.toHaveBeenCalled();
      if (failure === "parent deletion") {
        expect(lock).toBe(before);
      } else if (failure === "remote authorization") {
        expect(phases.slice(-2)).toEqual(["rollback", "rollback"]);
      }
    },
  );

  it.each(["staging", "destination"])(
    "does not restore over a changed %s owner",
    async (changed) => {
      const current = await fixture();
      const removal = await requirePlan(current);
      let active = true;
      let replacement = "";
      const renameSpy = vi.spyOn(fs, "rename").mockImplementation(async (from, to) => {
        await rename(from, to);
        active = false;
        replacement = changed === "staging" ? String(to) : current.skillDir;
        if (changed === "staging") {
          await rename(to, `${String(to)}.original`);
        }
        await mkdir(replacement);
        await writeFile(join(replacement, "SKILL.md"), "successor skill");
      });
      const result = await applyClawHubSkillUninstall(removal, {
        beforePersistentApply: () => {
          if (!active) {
            throw new Error("Parent deletion ended.");
          }
        },
      }).finally(() => renameSpy.mockRestore());
      expect(result).toMatchObject({
        ok: false,
        error: expect.stringContaining("staging or destination changed"),
      });
      await expect(readFile(join(replacement, "SKILL.md"), "utf8")).resolves.toBe(
        "successor skill",
      );
    },
  );
});
