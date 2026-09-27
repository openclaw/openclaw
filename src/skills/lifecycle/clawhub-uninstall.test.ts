import { createHash } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { registerAgentWorkspaceAccess } from "../../agents/workspace-access.js";
import {
  initializeGlobalHookRunner,
  resetGlobalHookRunner,
} from "../../plugins/hook-runner-global.js";
import { createMockPluginRegistry } from "../../plugins/hooks.test-fixtures.js";
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
  await writeFile(
    join(skillDir, ".clawhub", "origin.json"),
    JSON.stringify({
      version: 1,
      registry,
      slug,
      installedVersion: "1.0.0",
      installedAt,
      ownerHandle,
      skillFile: { path: "SKILL.md", sha256 },
      fileTreeSha256,
    }),
  );
  await writeFile(
    join(workspaceDir, ".clawhub", "lock.json"),
    JSON.stringify({
      version: 1,
      skills: {
        [slug]: {
          version: "1.0.0",
          registry,
          installedAt,
          ownerHandle,
          skillFile: { path: "SKILL.md", sha256 },
          fileTreeSha256,
        },
      },
    }),
  );
  return {
    workspaceDir,
    slug,
    skillDir,
    originPath: join(skillDir, ".clawhub", "origin.json"),
    lockPath: join(workspaceDir, ".clawhub", "lock.json"),
  };
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

  const lock = JSON.parse(await readFile(current.lockPath, "utf8")) as {
    skills: Record<string, { ownerHandle: string }>;
  };
  lock.skills[current.slug]!.ownerHandle = ownerHandle;
  await writeFile(current.lockPath, JSON.stringify(lock));
}

describe("ClawHub skill uninstall lifecycle", () => {
  it("uninstalls local Skills for document-only workspace adapters", async () => {
    const current = await fixture();
    const release = registerAgentWorkspaceAccess(current.workspaceDir, {
      bridge: { readFile: vi.fn(), writeFile: vi.fn(), stat: vi.fn() },
    });
    try {
      const result = await planClawHubSkillUninstall({ ...current, expectedVersion: "1.0.0" });
      expect(result.ok).toBe(true);
      if (!result.ok) {
        throw new Error(result.error);
      }
      expect(await applyClawHubSkillUninstall(result.plan)).toMatchObject({ ok: true });
      await expect(readFile(join(current.skillDir, "SKILL.md"))).rejects.toMatchObject({
        code: "ENOENT",
      });
    } finally {
      release();
    }
  });

  it.each(["apply", "rollback"])(
    "preserves sibling tracking changed while awaiting remote %s authorization",
    async (checkpoint) => {
      const current = await fixture();
      const before = JSON.parse(await readFile(current.lockPath, "utf8"));
      const restore = await untrackClawHubSkill(
        current.workspaceDir,
        current.slug,
        undefined,
        undefined,
        async (phase) => {
          if (phase === checkpoint) {
            const lock = JSON.parse(await readFile(current.lockPath, "utf8"));
            lock.skills.sibling = before.skills[current.slug];
            await writeFile(current.lockPath, JSON.stringify(lock));
          }
        },
      );
      if (checkpoint === "rollback") {
        await restore();
      }
      const after = JSON.parse(await readFile(current.lockPath, "utf8"));
      expect(after.skills.sibling).toEqual(before.skills[current.slug]);
    },
  );

  it("refuses a skill retracked while awaiting remote rollback authorization", async () => {
    const current = await fixture();
    const before = await readFile(current.lockPath, "utf8");
    const restore = await untrackClawHubSkill(
      current.workspaceDir,
      current.slug,
      undefined,
      undefined,
      async (phase) => {
        if (phase === "rollback") {
          await writeFile(current.lockPath, before);
        }
      },
    );
    await expect(restore()).rejects.toThrow("was retracked during rollback");
    expect(await readFile(current.lockPath, "utf8")).toBe(before);
  });

  it("waits for remote authorization but still checks local authority at publication", async () => {
    const current = await fixture();
    let owned = true;
    const before = await readFile(current.lockPath, "utf8");
    await expect(
      untrackClawHubSkill(
        current.workspaceDir,
        current.slug,
        () => {
          if (!owned) {
            throw new Error("superseded after authorization");
          }
        },
        undefined,
        async () => {
          owned = false;
        },
      ),
    ).rejects.toThrow("superseded after authorization");
    expect(await readFile(current.lockPath, "utf8")).toBe(before);
  });

  it("restores files and tracking through rollback authority after remote apply is revoked", async () => {
    const current = await fixture();
    const planned = await planClawHubSkillUninstall({
      workspaceDir: current.workspaceDir,
      slug: current.slug,
      expectedVersion: "1.0.0",
    });
    if (!planned.ok) {
      throw new Error(planned.error);
    }
    const before = await readFile(current.lockPath, "utf8");
    const phases: string[] = [];
    const result = await applyClawHubSkillUninstall(planned.plan, {
      authorizeMutation: async (phase) => {
        phases.push(phase);
        // Revoke after untracking, immediately before deleting the staged tree.
        if (phase === "apply" && phases.filter((entry) => entry === "apply").length === 4) {
          throw new Error("parent canceled");
        }
      },
    });
    expect(result).toMatchObject({ ok: false, error: expect.stringContaining("parent canceled") });
    expect(phases.slice(-2)).toEqual(["rollback", "rollback"]);
    expect(JSON.parse(await readFile(current.lockPath, "utf8"))).toEqual(JSON.parse(before));
    expect(await readFile(join(current.skillDir, "SKILL.md"), "utf8")).toContain(
      "Triage incidents",
    );
  });

  it.each(["untrack", "rollback"])("fences %s after its awaited lock read", async (phase) => {
    const current = await fixture();
    let owned = true;
    const guard = () => {
      if (!owned) {
        throw new Error("removal superseded");
      }
    };
    const restore =
      phase === "rollback"
        ? await untrackClawHubSkill(current.workspaceDir, current.slug, guard)
        : undefined;
    const before = await readFile(current.lockPath, "utf8");
    const pending = restore
      ? restore()
      : untrackClawHubSkill(current.workspaceDir, current.slug, guard);
    owned = false;
    await expect(pending).rejects.toThrow("removal superseded");
    await expect(readFile(current.lockPath, "utf8")).resolves.toBe(before);
  });

  it.each(["local", "forwarded", "forwarding-failed"])(
    "plans and removes an unchanged tracked skill with %s change delivery",
    async (delivery) => {
      const current = await fixture();
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
      const planned = await planClawHubSkillUninstall({
        workspaceDir: current.workspaceDir,
        slug: current.slug,
        expectedVersion: "1.0.0",
      });
      expect(planned).toMatchObject({
        ok: true,
        plan: { requestedRef: "triage", slug: "triage", version: "1.0.0" },
      });
      if (!planned.ok) {
        throw new Error(planned.error);
      }
      await expect(
        applyClawHubSkillUninstall(planned.plan, { onCommittedChange }),
      ).resolves.toEqual({ ok: true });
      await expect(readFile(join(current.skillDir, "SKILL.md"), "utf8")).rejects.toThrow();
      const lock = JSON.parse(
        await readFile(join(current.workspaceDir, ".clawhub", "lock.json"), "utf8"),
      );
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
    },
  );

  it("removes an owner-qualified tracked skill by its local slug", async () => {
    const current = await fixture();
    const planned = await planClawHubSkillUninstall({
      workspaceDir: current.workspaceDir,
      slug: "@owner/triage",
      expectedVersion: "1.0.0",
    });

    expect(planned).toMatchObject({
      ok: true,
      plan: { requestedRef: "@owner/triage", slug: "triage", version: "1.0.0" },
    });
    if (!planned.ok) {
      throw new Error(planned.error);
    }
    await expect(applyClawHubSkillUninstall(planned.plan)).resolves.toEqual({ ok: true });
    await expect(readFile(join(current.skillDir, "SKILL.md"), "utf8")).rejects.toThrow();
    const lock = JSON.parse(await readFile(current.lockPath, "utf8")) as {
      skills: Record<string, unknown>;
    };
    expect(lock.skills).toEqual({});
  });

  it("rejects an owner-qualified ref for a different tracked publisher", async () => {
    const current = await fixture();

    await expect(
      planClawHubSkillUninstall({
        workspaceDir: current.workspaceDir,
        slug: "@other/triage",
        expectedVersion: "1.0.0",
      }),
    ).resolves.toEqual({
      ok: false,
      code: "ambiguous",
      error: 'Skill "triage" is tracked as @owner/triage, not @other/triage.',
    });
    await expect(readFile(join(current.skillDir, "SKILL.md"), "utf8")).resolves.toContain(
      "name: triage",
    );
    const lock = JSON.parse(await readFile(current.lockPath, "utf8")) as {
      skills: Record<string, unknown>;
    };
    expect(lock.skills.triage).toBeDefined();
  });

  it("revalidates the requested publisher before applying removal", async () => {
    const current = await fixture();
    const planned = await planClawHubSkillUninstall({
      workspaceDir: current.workspaceDir,
      slug: "@owner/triage",
      expectedVersion: "1.0.0",
    });
    if (!planned.ok) {
      throw new Error(planned.error);
    }
    await replaceTrackedOwner(current, "other");

    await expect(applyClawHubSkillUninstall(planned.plan)).resolves.toEqual({
      ok: false,
      error: 'Skill "triage" is tracked as @other/triage, not @owner/triage.',
    });
    await expect(readFile(join(current.skillDir, "SKILL.md"), "utf8")).resolves.toContain(
      "name: triage",
    );
  });

  it("retains a locally modified skill", async () => {
    const current = await fixture();
    await writeFile(join(current.skillDir, "SKILL.md"), "operator edit\n");
    await expect(
      planClawHubSkillUninstall({
        workspaceDir: current.workspaceDir,
        slug: current.slug,
        expectedVersion: "1.0.0",
      }),
    ).resolves.toMatchObject({ ok: false, code: "modified" });
  });

  it("retains a skill with modified auxiliary files", async () => {
    const current = await fixture();
    await writeFile(join(current.skillDir, "script.js"), "operator addition\n");
    await expect(
      planClawHubSkillUninstall({
        workspaceDir: current.workspaceDir,
        slug: current.slug,
        expectedVersion: "1.0.0",
      }),
    ).resolves.toMatchObject({ ok: false, code: "modified" });
  });

  it("restores the staged skill when parent deletion ends before untracking", async () => {
    const current = await fixture();
    const beforeLock = await readFile(current.lockPath, "utf8");
    const planned = await planClawHubSkillUninstall({
      workspaceDir: current.workspaceDir,
      slug: current.slug,
      expectedVersion: "1.0.0",
    });
    if (!planned.ok) {
      throw new Error(planned.error);
    }
    let active = true;
    const deps = {
      beforePersistentApply: () => {
        if (!active) {
          throw new Error("Parent deletion ended.");
        }
      },
      rename: async (...args: Parameters<typeof rename>) => {
        await rename(...args);
        active = false;
      },
    };

    await expect(applyClawHubSkillUninstall(planned.plan, deps)).resolves.toMatchObject({
      ok: false,
      error: expect.stringContaining("Parent deletion ended."),
    });
    await expect(readFile(join(current.skillDir, "SKILL.md"), "utf8")).resolves.toContain(
      "name: triage",
    );
    await expect(readFile(current.lockPath, "utf8")).resolves.toBe(beforeLock);
  });

  it.each(["staging", "destination"])(
    "does not restore over a changed %s owner",
    async (changed) => {
      const current = await fixture();
      const planned = await planClawHubSkillUninstall({
        workspaceDir: current.workspaceDir,
        slug: current.slug,
        expectedVersion: "1.0.0",
      });
      if (!planned.ok) {
        throw new Error(planned.error);
      }
      let active = true;
      let replacement = "";
      const result = await applyClawHubSkillUninstall(planned.plan, {
        beforePersistentApply: () => {
          if (!active) {
            throw new Error("Parent deletion ended.");
          }
        },
        rename: async (from, to) => {
          await rename(from, to);
          active = false;
          replacement = changed === "staging" ? String(to) : current.skillDir;
          if (changed === "staging") {
            await rename(to, `${String(to)}.original`);
          }
          await mkdir(replacement);
          await writeFile(join(replacement, "SKILL.md"), "successor skill");
        },
      });
      expect(result).toMatchObject({
        ok: false,
        error: expect.stringContaining("staging or destination changed"),
      });
      await expect(readFile(join(replacement, "SKILL.md"), "utf8")).resolves.toBe(
        "successor skill",
      );
    },
  );

  it("restores the staged skill when lockfile untracking fails", async () => {
    const current = await fixture();
    const handler = vi.fn();
    initializeGlobalHookRunner(createMockPluginRegistry([{ hookName: "skill_changed", handler }]));
    const planned = await planClawHubSkillUninstall({
      workspaceDir: current.workspaceDir,
      slug: current.slug,
      expectedVersion: "1.0.0",
    });
    if (!planned.ok) {
      throw new Error(planned.error);
    }

    await expect(
      applyClawHubSkillUninstall(planned.plan, {
        untrack: async () => {
          throw new Error("lockfile write failed");
        },
      }),
    ).resolves.toMatchObject({
      ok: false,
      error: expect.stringContaining("lockfile write failed"),
    });
    await expect(readFile(join(current.skillDir, "SKILL.md"), "utf8")).resolves.toContain(
      "name: triage",
    );
    const lock = JSON.parse(
      await readFile(join(current.workspaceDir, ".clawhub", "lock.json"), "utf8"),
    );
    expect(lock.skills.triage).toBeDefined();
    expect(handler).not.toHaveBeenCalled();
  });
});
