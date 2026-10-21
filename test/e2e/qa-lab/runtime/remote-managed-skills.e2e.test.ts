import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { createWorkspaceFixture } from "../../../../extensions/file-transfer/src/workspace-fixture.test-support.js";
import {
  createNodeWorkspaceTestTransport,
  registerNodeWorkspaces,
} from "../../../../extensions/file-transfer/test-api.js";
import { requireGit } from "../../../../src/agents/worktrees/git.js";
import { ManagedWorktreeService } from "../../../../src/agents/worktrees/service.js";
import { ensureSkillSnapshot } from "../../../../src/auto-reply/reply/session-updates.js";
import {
  clearRuntimeConfigSnapshot,
  setRuntimeConfigSnapshot,
} from "../../../../src/config/runtime-snapshot.js";
import type { SessionEntry } from "../../../../src/config/sessions/types.js";
import { closeSkillsWatchers } from "../../../../src/skills/runtime/refresh.js";
import { resolveSkillFileHost } from "../../../../src/skills/skill-file-host.js";
import { writeSkill } from "../../../../src/skills/test-support/e2e-test-helpers.js";
import {
  closeOpenClawStateDatabaseAsync,
  closeOpenClawStateDatabaseForTest,
} from "../../../../src/state/openclaw-state-db.js";
import { useAutoCleanupTempDirTracker } from "../../../helpers/temp-dir.js";

const dirs = useAutoCleanupTempDirTracker(afterEach);
const writeHostSkill = (root: string, name: string, host: "Gateway" | "Node") =>
  writeSkill({
    dir: path.join(root, "skills", name),
    name,
    description: `${host} skill`,
    body: `${host} instructions`,
  });
afterEach(async () => {
  await closeSkillsWatchers(true);
  await closeOpenClawStateDatabaseAsync();
  closeOpenClawStateDatabaseForTest();
  clearRuntimeConfigSnapshot();
  vi.unstubAllEnvs();
});

it.skipIf(process.platform === "win32").each(["empty", "repository"] as const)(
  "prepares %s canonical skills on their owning host",
  async (kind) => {
    const root = dirs.make("remote-managed-skills-");
    const fixture = await createWorkspaceFixture(root);
    const { local, remote, scheduler } = fixture;
    const stateDir = path.join(root, "gateway-state");
    vi.stubEnv("OPENCLAW_TEST_FAST", "0");
    const worktrees = new ManagedWorktreeService({
      env: { ...process.env, OPENCLAW_STATE_DIR: stateDir },
      getConfig: () => ({ worktreeAcceleration: false }),
    });
    const owner = { ownerKind: "session" as const, ownerId: "agent:main:" + kind, name: kind };
    const source = path.join(root, "gateway-repository");
    if (kind === "repository") {
      await fs.mkdir(source);
      await requireGit(source, ["init", "-b", "main"]);
      await writeHostSkill(source, "project-only", "Gateway");
      await requireGit(source, ["add", "."]);
      const identity = ["-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid"];
      await requireGit(source, [...identity, "commit", "-m", "Fixture"]);
    }
    const worktreeOptions = { ...owner, repoRoot: source, baseRef: "HEAD", runSetupScript: false };
    const worktree =
      kind === "empty"
        ? await worktrees.createEmpty(owner)
        : await worktrees.create(worktreeOptions);
    await writeHostSkill(remote, "agent-only", "Node");
    Object.assign(fixture.nodePolicy, { ask: "off", denyPaths: [] });
    const config = {
      agents: { entries: { main: { workspace: local, agentDir: path.join(stateDir, "agent") } } },
      plugins: { ...fixture.api.config.plugins, enabled: false },
    };
    fixture.api.config = config;
    setRuntimeConfigSnapshot(config);
    registerNodeWorkspaces(fixture.api);
    fixture.openDuplex = createNodeWorkspaceTestTransport(fixture.api, remote);
    const context = { ...fixture.context(), config, stateDir };
    const service = fixture.service;
    await service.start(context);
    const { id, branch, repoRoot } = worktree;
    const entry: SessionEntry = {
      sessionId: kind,
      updatedAt: 1,
      worktree: { id, branch, repoRoot, canonicalWorkspaceDir: repoRoot },
    };
    try {
      for (const isFirstTurnInSession of [true, false]) {
        const { skillsSnapshot } = await ensureSkillSnapshot({
          agentId: "main",
          workspaceDir: local,
          cfg: config,
          isFirstTurnInSession,
          sessionEntry: entry,
          executionWorkspaceDir: repoRoot,
        });
        const serializedSnapshot = JSON.stringify(skillsSnapshot);
        entry.skillsSnapshot = JSON.parse(serializedSnapshot);
        for (const [name, skillRoot, host] of [
          ["agent-only", remote, "workspace"],
          ...(kind === "repository" ? [["project-only", source, "gateway"]] : []),
        ]) {
          const skill = skillsSnapshot?.resolvedSkills?.find(
            (candidate) => candidate.name === name,
          );
          expect(skill?.filePath).toBe(path.join(skillRoot!, "skills", name!, "SKILL.md"));
          expect(resolveSkillFileHost(skill!)).toBe(host);
        }
      }
    } finally {
      scheduler.beginClose();
      try {
        await service.stop?.(context);
      } finally {
        await scheduler.stop();
      }
    }
  },
  60_000,
);
