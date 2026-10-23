import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import {
  createNodeWorkspaceTestTransport,
  registerNodeWorkspaces,
} from "../../../../extensions/file-transfer/test-api.js";
import { getAgentWorkspaceAccess } from "../../../../src/agents/workspace-access.js";
import { requireGit } from "../../../../src/agents/worktrees/git.js";
import { ManagedWorktreeService } from "../../../../src/agents/worktrees/service.js";
import { ensureSkillSnapshot } from "../../../../src/auto-reply/reply/session-updates.js";
import {
  clearRuntimeConfigSnapshot,
  setRuntimeConfigSnapshot,
} from "../../../../src/config/runtime-snapshot.js";
import type { SessionEntry } from "../../../../src/config/sessions/types.js";
import {
  createTestPluginApi,
  createTestPluginServiceScheduler,
} from "../../../../src/plugin-sdk/plugin-test-api.js";
import type { OpenClawPluginApi } from "../../../../src/plugins/types.js";
import { prepareWorkspaceSkills } from "../../../../src/skills/loading/workspace-skill-loader.js";
import { closeSkillsWatchers } from "../../../../src/skills/runtime/refresh.js";
import {
  prepareSkillResourceDelivery,
  materializeSkillResources,
} from "../../../../src/skills/runtime/resources.js";
import { resolveSkillFileHost } from "../../../../src/skills/skill-file-host.js";
import { writeSkill } from "../../../../src/skills/test-support/e2e-test-helpers.js";
import {
  closeOpenClawStateDatabaseAsync,
  closeOpenClawStateDatabaseForTest,
} from "../../../../src/state/openclaw-state-db.js";
import { useAutoCleanupTempDirTracker } from "../../../helpers/temp-dir.js";

const dirs = useAutoCleanupTempDirTracker(afterEach);
const ignore = () => {};
type SkillRequest = { operation: string; request: string };
async function writeResourceSkill(root: string, name: string, host: "Gateway" | "Node") {
  const dir = path.join(root, "skills", name);
  await writeSkill({ dir, name, description: `${host} skill`, body: `${host} instructions` });
  await fs.writeFile(path.join(dir, "resource.txt"), `${host} resource`);
}
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
    const local = path.join(root, "gateway-agent");
    const remote = path.join(root, "node-agent");
    const stateDir = path.join(root, "gateway-state");
    await fs.mkdir(local, { recursive: true });
    await fs.mkdir(remote, { recursive: true });
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
      await writeResourceSkill(source, "project-only", "Gateway");
      await requireGit(source, ["add", "."]);
      const identity = ["-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid"];
      await requireGit(source, [...identity, "commit", "-m", "Fixture"]);
    }
    const worktreeOptions = { ...owner, repoRoot: source, baseRef: "HEAD", runSetupScript: false };
    const worktree =
      kind === "empty"
        ? await worktrees.createEmpty(owner)
        : await worktrees.create(worktreeOptions);
    await writeResourceSkill(remote, "agent-only", "Node");
    const denyPaths: string[] = [];
    const policy = { allowReadPaths: [remote, remote + "/**"], denyPaths, ask: "off" };
    const pluginConfig = {
      policyVersion: 2,
      workspaces: { main: { nodeId: "node-1", remoteRoot: remote } },
      nodes: { "node-1": policy },
    };
    const config = {
      agents: { entries: { main: { workspace: local, agentDir: path.join(stateDir, "agent") } } },
      plugins: { enabled: false, entries: { "file-transfer": { config: pluginConfig } } },
    };
    setRuntimeConfigSnapshot(config);
    const registerService = vi.fn<OpenClawPluginApi["registerService"]>();
    const runtime = { agent: { resolveAgentWorkspaceDir: () => local } };
    const api = createTestPluginApi({
      config,
      pluginConfig,
      runtime: runtime as unknown as OpenClawPluginApi["runtime"],
      registerService,
    });
    registerNodeWorkspaces(api);
    const service = registerService.mock.calls[0]![0];
    const transport = vi.fn(createNodeWorkspaceTestTransport(api, remote));
    const scheduler = createTestPluginServiceScheduler();
    const context = {
      scheduler,
      config,
      logger: api.logger,
      stateDir,
      invokeNode: vi.fn(),
      openNodeDuplex: transport,
    };
    await service.start(context);
    const retainedReader = getAgentWorkspaceAccess(local)!.skillResources!;
    const { id, branch, repoRoot } = worktree;
    const entry: SessionEntry = {
      sessionId: kind,
      updatedAt: 1,
      worktree: { id, branch, repoRoot, canonicalWorkspaceDir: repoRoot },
    };
    const snapshot = (sessionEntry?: SessionEntry, isFirstTurnInSession = true) =>
      ensureSkillSnapshot({
        agentId: "main",
        workspaceDir: local,
        cfg: config,
        isFirstTurnInSession,
        sessionEntry,
        executionWorkspaceDir: sessionEntry?.worktree?.canonicalWorkspaceDir,
      });
    try {
      const control = await snapshot();
      expect(control.skillsSnapshot?.skills).toEqual(
        expect.arrayContaining([expect.objectContaining({ name: "agent-only" })]),
      );
      for (const isFirstTurnInSession of [true, false]) {
        const { skillsSnapshot } = await snapshot(entry, isFirstTurnInSession);
        const serializedSnapshot = JSON.stringify(skillsSnapshot);
        entry.skillsSnapshot = JSON.parse(serializedSnapshot);
        const delivery = await prepareSkillResourceDelivery(skillsSnapshot, ignore, [], local);
        const materialized = await materializeSkillResources(delivery!, ignore);
        try {
          for (const [name, skillRoot, host] of [
            ["agent-only", remote, "workspace"],
            ...(kind === "repository" ? [["project-only", source, "gateway"]] : []),
          ]) {
            const original = skillsSnapshot?.resolvedSkills?.find((skill) => skill.name === name);
            expect(original?.filePath).toBe(path.join(skillRoot!, "skills", name!, "SKILL.md"));
            expect(resolveSkillFileHost(original!)).toBe(host);
            const copied = materialized.snapshot.resolvedSkills!.find((s) => s.name === name)!;
            const label = name === "agent-only" ? "Node" : "Gateway";
            expect(await fs.readFile(copied.filePath, "utf8")).toContain(`${label} instructions`);
            const resource = path.join(copied.baseDir, "resource.txt");
            expect(await fs.readFile(resource, "utf8")).toBe(`${label} resource`);
          }
        } finally {
          await materialized.cleanup();
        }
      }
      const requests = transport.mock.calls.map(([call]) => call.params as SkillRequest);
      expect(requests.map((r) => r.operation)).toContain("watch");
      expect(requests.map((r) => r.operation)).toContain("discovery");
      for (const request of requests.filter((r) => ["watch", "discovery"].includes(r.operation))) {
        expect(request.request).not.toContain(worktree.repoRoot);
      }
      denyPaths.push(path.join(remote, "skills", "agent-only", "SKILL.md"));
      await expect(
        prepareWorkspaceSkills(local, {
          config,
          executionWorkspaceDir: worktree.repoRoot,
          executionWorkspaceFileHost: "gateway",
        }),
      ).rejects.toMatchObject({
        message: "Remote workspace skill discovery failed",
        cause: { message: expect.stringContaining("denied by the node file read policy") },
      });
    } finally {
      scheduler.beginClose();
      try {
        await service.stop?.(context);
      } finally {
        await scheduler.stop();
      }
    }
    expect(() => getAgentWorkspaceAccess(local)).toThrow("stopped or not ready");
    await expect(
      retainedReader.readInstructions(path.join(remote, "skills", "agent-only", "SKILL.md"), {}),
    ).rejects.toThrow("stopped or not ready");
  },
  60_000,
);
