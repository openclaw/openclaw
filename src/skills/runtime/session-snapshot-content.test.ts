import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { writeSkill } from "../test-support/e2e-test-helpers.js";
import { getSkillsSnapshotVersion, registerSkillsChangeListener } from "./refresh-state.js";
import { closeSkillsWatchers, refreshSkillsDiscovery } from "./refresh.js";
import { resolveReusableWorkspaceSkillSnapshot } from "./session-snapshot.js";

const tempDirs = useAutoCleanupTempDirTracker((cleanup) =>
  afterEach(async () => {
    await closeSkillsWatchers(true);
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    cleanup();
  }),
);
beforeEach(() => {
  const home = tempDirs.make("skills-content-home-");
  for (const [key, value] of Object.entries({
    HOME: home,
    USERPROFILE: home,
    OPENCLAW_HOME: home,
    OPENCLAW_STATE_DIR: path.join(home, "state"),
    OPENCLAW_BUNDLED_SKILLS_DIR: path.join(home, "bundled-skills"),
    OPENCLAW_BUNDLED_PLUGINS_DIR: path.join(home, "plugins"),
  })) {
    vi.stubEnv(key, value);
  }
  vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
});
const config = { plugins: { enabled: false } };

describe("content-addressed skill refresh", () => {
  it("honors a per-call passive refresh opt-out without disabling another observer", async () => {
    const workspaceDir = tempDirs.make("skills-content-no-watch-");
    const skillDir = path.join(workspaceDir, "skills", "demo");
    await writeSkill({ dir: skillDir, name: "demo", description: "Original" });
    const params = { workspaceDir, config, watch: false };
    const original = await resolveReusableWorkspaceSkillSnapshot(params);
    await writeSkill({ dir: skillDir, name: "demo", description: "Passive change" });
    await vi.advanceTimersByTimeAsync(60_000);
    const unobserved = await resolveReusableWorkspaceSkillSnapshot({
      ...params,
      existingSnapshot: original.snapshot,
    });
    expect(unobserved.snapshot).toBe(original.snapshot);

    // A separate consumer owns observation; an opt-out read must not turn it off.
    await resolveReusableWorkspaceSkillSnapshot({ ...params, watch: true });
    await resolveReusableWorkspaceSkillSnapshot(params);
    const published = new Promise<void>((resolve) => {
      const unregister = registerSkillsChangeListener((event) => {
        if (event.workspaceDir === workspaceDir && event.reason === "watch") {
          unregister();
          resolve();
        }
      });
    });
    await vi.advanceTimersByTimeAsync(60_000);
    await published;
    const observed = await resolveReusableWorkspaceSkillSnapshot({
      ...params,
      existingSnapshot: original.snapshot,
    });
    expect(observed.shouldRefresh).toBe(true);
    expect(observed.snapshot.prompt).toContain("Passive change");
  });

  it("reuses session snapshots after unchanged rebuilds and refreshes instruction-only edits", async () => {
    const workspaceDir = tempDirs.make("skills-content-");
    vi.stubEnv("OPENCLAW_STATE_DIR", workspaceDir);
    const skillDir = path.join(workspaceDir, "skills", "demo");
    await writeSkill({ dir: skillDir, name: "demo", description: "Demo", body: "Original body" });
    const params = { workspaceDir, config };
    const first = await resolveReusableWorkspaceSkillSnapshot(params);
    const version = getSkillsSnapshotVersion(workspaceDir);
    const changed = vi.fn();
    const unregister = registerSkillsChangeListener(changed);
    try {
      await vi.advanceTimersByTimeAsync(60_000);
      const next = await resolveReusableWorkspaceSkillSnapshot({
        ...params,
        existingSnapshot: first.snapshot,
      });
      expect(getSkillsSnapshotVersion(workspaceDir)).toBe(version);
      expect(next.snapshot).toBe(first.snapshot);
      expect(next.shouldRefresh).toBe(false);
      expect(changed).not.toHaveBeenCalled();
      await fs.appendFile(path.join(skillDir, "SKILL.md"), "\nNew instructions\n");
      await vi.advanceTimersByTimeAsync(60_000);
      const edited = await resolveReusableWorkspaceSkillSnapshot({
        ...params,
        existingSnapshot: first.snapshot,
      });
      expect(edited.shouldRefresh).toBe(true);
      expect(edited.snapshotVersion).toBeGreaterThan(version);
      expect(edited.snapshot.prompt).toBe(first.snapshot.prompt);
      expect(edited.snapshot.resolvedSkills?.[0]?.contentHash).not.toBe(
        first.snapshot.resolvedSkills?.[0]?.contentHash,
      );
      expect(changed).toHaveBeenCalledOnce();
    } finally {
      unregister();
    }
  });

  it("refreshes changed installed skill identities even when instructions are identical", async () => {
    const workspaceDir = tempDirs.make("skills-content-identity-");
    vi.stubEnv("OPENCLAW_STATE_DIR", workspaceDir);
    const skillDir = path.join(workspaceDir, "skills", "demo");
    await writeSkill({ dir: skillDir, name: "demo", description: "Demo" });
    const originDir = path.join(skillDir, ".openclaw");
    const originFile = path.join(originDir, "source-origin.json");
    await fs.mkdir(originDir);
    await fs.writeFile(originFile, JSON.stringify({ slug: "demo-original" }));
    const params = { workspaceDir, config };
    const first = await resolveReusableWorkspaceSkillSnapshot(params);
    expect(first.snapshot.skills[0]?.skillKey).toBe("demo-original");
    await fs.writeFile(originFile, JSON.stringify({ slug: "demo-renamed" }));
    await refreshSkillsDiscovery({ workspaceDir });
    const next = await resolveReusableWorkspaceSkillSnapshot({
      ...params,
      existingSnapshot: first.snapshot,
    });
    expect(next.shouldRefresh).toBe(true);
    expect(next.snapshot.skills[0]?.skillKey).toBe("demo-renamed");
    expect(next.snapshot.resolvedSkills?.[0]?.contentHash).toBe(
      first.snapshot.resolvedSkills?.[0]?.contentHash,
    );
  });

  it("keeps execution workspace content isolated while refreshing active sessions", async () => {
    const workspaceDir = tempDirs.make("skills-content-scopes-");
    vi.stubEnv("OPENCLAW_STATE_DIR", workspaceDir);
    const firstScope = { executionWorkspaceDir: path.join(workspaceDir, "first") };
    const secondScope = { executionWorkspaceDir: path.join(workspaceDir, "second") };
    const firstParams = {
      workspaceDir,
      config,
      executionWorkspaceDir: path.relative(process.cwd(), firstScope.executionWorkspaceDir),
    };
    const secondParams = { ...firstParams, ...secondScope };
    for (const [scope, description] of [
      [firstScope, "First scope"],
      [secondScope, "Second scope"],
    ] as const) {
      await writeSkill({
        dir: path.join(scope.executionWorkspaceDir, "skills", "demo"),
        name: "demo",
        description,
      });
    }
    const first = await resolveReusableWorkspaceSkillSnapshot(firstParams);
    const second = await resolveReusableWorkspaceSkillSnapshot(secondParams);
    await writeSkill({
      dir: path.join(firstScope.executionWorkspaceDir, "skills", "demo"),
      name: "demo",
      description: "Changed first scope",
    });
    await refreshSkillsDiscovery({ workspaceDir });
    const refreshed = await resolveReusableWorkspaceSkillSnapshot({
      ...firstParams,
      existingSnapshot: first.snapshot,
    });
    const unrelated = await resolveReusableWorkspaceSkillSnapshot({
      ...secondParams,
      existingSnapshot: second.snapshot,
    });
    expect(refreshed.snapshot.prompt).toContain("Changed first scope");
    expect(unrelated.snapshot.prompt).toContain("Second scope");
    expect(unrelated.snapshot.prompt).not.toContain("Changed first scope");
    expect(unrelated.snapshot.resolvedSkills?.[0]?.filePath).toBe(
      path.join(secondScope.executionWorkspaceDir, "skills", "demo", "SKILL.md"),
    );
  });

  it("uses incoming roots before deciding whether a warm session can be reused", async () => {
    const workspaceDir = tempDirs.make("skills-content-roots-");
    vi.stubEnv("OPENCLAW_STATE_DIR", workspaceDir);
    const firstRoot = path.join(workspaceDir, "first");
    const secondRoot = path.join(workspaceDir, "second");
    await writeSkill({ dir: path.join(firstRoot, "demo"), name: "demo", description: "Before" });
    await writeSkill({ dir: path.join(secondRoot, "demo"), name: "demo", description: "After" });
    const firstConfig = {
      ...config,
      agents: { defaults: { workspace: workspaceDir } },
      skills: { load: { extraDirs: [firstRoot] } },
    };
    const nextConfig = {
      ...config,
      agents: { defaults: { workspace: workspaceDir } },
      skills: { load: { extraDirs: [secondRoot] } },
    };
    const first = await resolveReusableWorkspaceSkillSnapshot({
      workspaceDir,
      config: firstConfig,
    });
    await refreshSkillsDiscovery({
      workspaceDir,
      reason: "config-change",
      config: nextConfig,
    });
    const next = await resolveReusableWorkspaceSkillSnapshot({
      workspaceDir,
      config: nextConfig,
      existingSnapshot: first.snapshot,
    });
    expect(next.shouldRefresh).toBe(true);
    expect(next.snapshot.prompt).toContain("After");
    expect(next.snapshot.prompt).not.toContain("Before");
  });

  it("refreshes an existing session after its workspace is replaced", async () => {
    const workspaceDir = tempDirs.make("skills-content-replaced-");
    vi.stubEnv("OPENCLAW_STATE_DIR", workspaceDir);
    const skillDir = path.join(workspaceDir, "skills", "demo");
    await writeSkill({ dir: skillDir, name: "demo", description: "Original workspace" });
    const params = { workspaceDir, config };
    const first = await resolveReusableWorkspaceSkillSnapshot(params);
    await fs.rename(workspaceDir, path.join(tempDirs.make("skills-content-old-"), "workspace"));
    await writeSkill({ dir: skillDir, name: "demo", description: "Replacement workspace" });
    await vi.advanceTimersByTimeAsync(60_000);
    const next = await resolveReusableWorkspaceSkillSnapshot({
      ...params,
      existingSnapshot: first.snapshot,
    });
    expect(next.shouldRefresh).toBe(true);
    expect(next.snapshot.prompt).toContain("Replacement workspace");
    expect(next.snapshot.prompt).not.toContain("Original workspace");
    expect(next.snapshot.resolvedSkills?.[0]?.filePath).toBe(path.join(skillDir, "SKILL.md"));
  });

  it("ignores losing skill edits but refreshes when the precedence winner disappears", async () => {
    const workspaceDir = tempDirs.make("skills-content-precedence-");
    vi.stubEnv("OPENCLAW_STATE_DIR", workspaceDir);
    const executionWorkspaceDir = path.join(workspaceDir, "worktree");
    const winner = path.join(workspaceDir, "skills", "demo");
    const loser = path.join(executionWorkspaceDir, "skills", "demo");
    await writeSkill({ dir: winner, name: "demo", description: "Winner" });
    await writeSkill({ dir: loser, name: "demo", description: "Loser" });
    const params = {
      workspaceDir,
      config,
      executionWorkspaceDir,
    };
    const first = await resolveReusableWorkspaceSkillSnapshot(params);
    expect(first.snapshot.prompt).toContain("Winner");
    const version = getSkillsSnapshotVersion(workspaceDir);
    await fs.appendFile(path.join(loser, "SKILL.md"), "\nChanged loser\n");
    await vi.advanceTimersByTimeAsync(60_000);
    const unchanged = await resolveReusableWorkspaceSkillSnapshot({
      ...params,
      existingSnapshot: first.snapshot,
    });
    expect(getSkillsSnapshotVersion(workspaceDir)).toBe(version);
    expect(unchanged.snapshot).toBe(first.snapshot);
    expect(unchanged.shouldRefresh).toBe(false);
    await fs.unlink(path.join(winner, "SKILL.md"));
    await vi.advanceTimersByTimeAsync(60_000);
    const fallback = await resolveReusableWorkspaceSkillSnapshot({
      ...params,
      existingSnapshot: first.snapshot,
    });
    expect(getSkillsSnapshotVersion(workspaceDir)).toBeGreaterThan(version);
    expect(fallback.shouldRefresh).toBe(true);
    expect(fallback.snapshot.prompt).toContain("Loser");
    expect(fallback.snapshot.resolvedSkills?.[0]?.filePath).toBe(path.join(loser, "SKILL.md"));
  });
});
