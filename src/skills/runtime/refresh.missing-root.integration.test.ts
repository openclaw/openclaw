import { AsyncLocalStorage } from "node:async_hooks";
import nativeFs from "node:fs";
import fs from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import os from "node:os";
import path from "node:path";
import { expect, it, vi } from "vitest";

vi.mock("../loading/plugin-skills.js", () => ({
  resolvePluginSkillRoots: () => [],
  resolvePluginSkillRootsFromMetadata: () => [],
}));

it.each(["initial", "closed", "disabled", "evicted"] as const)(
  "reads repaired skills immediately after %s watcher acquisition",
  async (lifecycle) => {
    const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "skills-acquire-")));
    const workspaceDir = path.join(root, "workspace");
    const skillDir = path.join(workspaceDir, "skills", "acquire-proof");
    const skillFile = path.join(skillDir, "SKILL.md");
    const { ensureSkillsWatcher, closeSkillsWatchers } = await import("./refresh.js");
    const { getSkillsSnapshotVersion } = await import("./refresh-state.js");
    const { loadWorkspaceSkills } = await import("../loading/workspace-skill-loader.js");
    const options = { config: {}, agentId: "main" };
    try {
      await fs.mkdir(skillDir, { recursive: true });
      if (lifecycle !== "initial") {
        ensureSkillsWatcher({ workspaceDir, ...options });
        if (lifecycle === "closed") {
          await closeSkillsWatchers();
        } else if (lifecycle === "disabled") {
          ensureSkillsWatcher({
            workspaceDir,
            ...options,
            config: { skills: { load: { watch: false } } },
          });
        } else {
          const clock = vi.spyOn(Date, "now").mockReturnValue(Date.now() + 61 * 60_000);
          try {
            ensureSkillsWatcher({ workspaceDir: path.join(root, "other"), ...options });
          } finally {
            clock.mockRestore();
          }
        }
      }
      // Cache the invalid file after teardown, so teardown invalidation cannot
      // accidentally prove freshness on reacquisition.
      nativeFs.writeFileSync(skillFile, "not valid skill frontmatter\n");
      const readSkill = () =>
        loadWorkspaceSkills(workspaceDir, options).find(
          (entry) => entry.skill.name === "acquire-proof",
        );
      expect(readSkill()).toBeUndefined();
      nativeFs.writeFileSync(
        skillFile,
        "---\nname: acquire-proof\ndescription: Repaired before acquisition\n---\n",
      );
      expect(readSkill()).toBeUndefined();
      // No await: the first synchronous consumer must not need a ready/change event.
      ensureSkillsWatcher({ workspaceDir, ...options });
      expect(readSkill()?.skill.description).toBe("Repaired before acquisition");
      const version = getSkillsSnapshotVersion(workspaceDir);
      ensureSkillsWatcher({ workspaceDir, ...options });
      expect(getSkillsSnapshotVersion(workspaceDir)).toBe(version);
    } finally {
      await closeSkillsWatchers();
      await fs.rm(root, { recursive: true, force: true });
    }
  },
);

it.each(["create", "edit"] as const)(
  "refreshes cached skills after %s during initial watcher registration",
  async (operation) => {
    const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "skills-scan-proof-")));
    const workspaceDir = path.join(root, "workspace");
    const skillDir = path.join(workspaceDir, "skills", "scan-proof");
    const skillFile = path.join(skillDir, "SKILL.md");
    const contents = (description: string) =>
      `---\nname: scan-proof\ndescription: ${description}\n---\n`;
    const { ensureSkillsWatcher, closeSkillsWatchers } = await import("./refresh.js");
    const { loadWorkspaceSkills } = await import("../loading/workspace-skill-loader.js");
    const options = { config: {}, agentId: "main" };
    try {
      await fs.mkdir(path.dirname(skillDir), { recursive: true });
      if (operation === "edit") {
        await fs.mkdir(skillDir, { recursive: true });
        await fs.writeFile(skillFile, contents("Before registration"));
      }
      ensureSkillsWatcher({ workspaceDir, ...options });
      const cached = loadWorkspaceSkills(workspaceDir, options);
      expect(cached.find((entry) => entry.skill.name === "scan-proof")?.skill.description).toBe(
        operation === "edit" ? "Before registration" : undefined,
      );
      // Keep the write in this turn, before native watcher registration, so
      // refresh cannot depend on receiving a subsequent file-change event.
      nativeFs.mkdirSync(skillDir, { recursive: true });
      nativeFs.writeFileSync(skillFile, contents("After registration"));
      await expect
        .poll(
          () =>
            loadWorkspaceSkills(workspaceDir, options).find(
              (entry) => entry.skill.name === "scan-proof",
            )?.skill.description,
          { timeout: 3_000 },
        )
        .toBe("After registration");
    } finally {
      await closeSkillsWatchers();
      await fs.rm(root, { recursive: true, force: true });
    }
  },
);

it("refreshes skills created beneath an initially missing project skills root", async () => {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "skills-root-proof-")));
  const workspaceDir = path.join(root, "workspace");
  await fs.mkdir(path.join(workspaceDir, "skills", "existing"), { recursive: true });
  const registeredPaths = new Set<string>();
  const turnContext = new AsyncLocalStorage<string>();
  const pendingInputContext = new AsyncLocalStorage<string>();
  const inheritedContexts: Array<{ turn?: string; pendingInput?: string }> = [];
  const originalWatch = nativeFs.watch;
  const watchObserver = vi.spyOn(nativeFs, "watch").mockImplementation((...args) => {
    inheritedContexts.push({
      turn: turnContext.getStore(),
      pendingInput: pendingInputContext.getStore(),
    });
    const watcher = originalWatch(...args);
    registeredPaths.add(path.resolve(String(args[0])));
    return watcher;
  });
  syncBuiltinESMExports();
  const { ensureSkillsWatcher, closeSkillsWatchers, registerSkillsChangeListener } =
    await import("./refresh.js");
  const changes: string[] = [];
  const unregister = registerSkillsChangeListener((event) => {
    if (event.workspaceDir === workspaceDir && event.reason === "watch" && event.changedPath) {
      changes.push(event.changedPath);
    }
  });
  try {
    turnContext.run("active turn", () => {
      pendingInputContext.run("accepted input", () => {
        ensureSkillsWatcher({ workspaceDir });
        expect(turnContext.getStore()).toBe("active turn");
        expect(pendingInputContext.getStore()).toBe("accepted input");
      });
    });
    const existingSkill = path.join(workspaceDir, "skills", "existing", "SKILL.md");
    // This control covers writes after registration; the cases above cover
    // cached discovery while the initial scan is still pending.
    await vi.waitFor(() => {
      expect(registeredPaths.has(workspaceDir)).toBe(true);
      expect(registeredPaths.has(path.dirname(existingSkill))).toBe(true);
    });
    await fs.writeFile(existingSkill, "existing skill");
    await vi.waitFor(() => expect(changes).toContain(existingSkill), { timeout: 3_000 });
    const newSkill = path.join(workspaceDir, ".agents", "skills", "new", "SKILL.md");
    await fs.mkdir(path.dirname(newSkill), { recursive: true });
    await fs.writeFile(newSkill, "new skill");
    await vi.waitFor(
      () => {
        expect(
          changes.some((changed) => changed.startsWith(path.join(workspaceDir, ".agents"))),
        ).toBe(true);
      },
      { timeout: 3_000 },
    );
    expect(inheritedContexts.length).toBeGreaterThan(0);
    for (const context of inheritedContexts) {
      expect(context).toEqual({ turn: undefined, pendingInput: undefined });
    }
  } finally {
    unregister();
    await closeSkillsWatchers();
    watchObserver.mockRestore();
    syncBuiltinESMExports();
    await fs.rm(root, { recursive: true, force: true });
  }
});
