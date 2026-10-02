import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, expect, it, vi } from "vitest";
import {
  createNodeWorkspaceTestTransport,
  registerNodeWorkspaces,
} from "../../../../extensions/file-transfer/test-api.js";
import { getAgentWorkspaceAccess } from "../../../../src/agents/workspace-access.js";
import { requireGit } from "../../../../src/agents/worktrees/git.js";
import { ManagedWorktreeService } from "../../../../src/agents/worktrees/service.js";
import { ensureSkillSnapshot } from "../../../../src/auto-reply/reply/session-updates.js";
import type { SessionEntry } from "../../../../src/config/sessions/types.js";
import { createTestPluginApi } from "../../../../src/plugin-sdk/plugin-test-api.js";
import type { OpenClawPluginApi, OpenClawPluginService } from "../../../../src/plugins/types.js";
import { resolveSkillFileHost } from "../../../../src/skills/loading/skill-file-host.js";
import { prepareWorkspaceSkills } from "../../../../src/skills/loading/workspace-skill-loader.js";
import { closeSkillsWatchers } from "../../../../src/skills/runtime/refresh.js";
import {
  prepareSkillResourceDelivery,
  materializeSkillResources,
} from "../../../../src/skills/runtime/resources.js";
import { writeSkill } from "../../../../src/skills/test-support/e2e-test-helpers.js";
import {
  closeOpenClawStateDatabaseAsync,
  closeOpenClawStateDatabaseForTest,
} from "../../../../src/state/openclaw-state-db.js";
import { useAutoCleanupTempDirTracker } from "../../../helpers/temp-dir.js";

vi.mock("openclaw/plugin-sdk/agent-workspace-runtime", async (importOriginal) => {
  const original =
    await importOriginal<typeof import("../../../../src/plugin-sdk/agent-workspace-runtime.js")>();
  return {
    ...original,
    resolveWorkspaceWorkerArgv(kind: "memory" | "skills") {
      const argv = original.resolveWorkspaceWorkerArgv(kind);
      const register =
        "import { register } from " +
        JSON.stringify(import.meta.resolve("tsx/esm/api")) +
        "; register({ tsconfig: " +
        JSON.stringify(fileURLToPath(new URL("../../../../tsconfig.json", import.meta.url))) +
        " });";
      return argv[0] === "--import"
        ? ["--import", "data:text/javascript," + encodeURIComponent(register), ...argv.slice(2)]
        : argv;
    },
  };
});
const dirs = useAutoCleanupTempDirTracker(afterEach);
afterEach(async () => {
  await closeSkillsWatchers(true);
  await closeOpenClawStateDatabaseAsync();
  closeOpenClawStateDatabaseForTest();
  vi.unstubAllEnvs();
});

// Release composition: real managed Git source -> reply skill preparation -> registered
// file-transfer service -> real node policy/helper, before inference is admitted.
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
    const env = { ...process.env, OPENCLAW_STATE_DIR: stateDir };
    const worktrees = new ManagedWorktreeService({
      env,
      getConfig: () => ({ worktreeAcceleration: false }),
    });
    const owner = { ownerKind: "session" as const, ownerId: "agent:main:" + kind, name: kind };
    const source = path.join(root, "gateway-repository");
    if (kind === "repository") {
      await fs.mkdir(source);
      await requireGit(source, ["init", "-b", "main"]);
      await writeSkill({
        dir: path.join(source, "skills", "project-only"),
        name: "project-only",
        description: "Canonical project skill",
        body: "Gateway project instructions",
      });
      await fs.writeFile(
        path.join(source, "skills", "project-only", "resource.txt"),
        "Gateway project resource",
      );
      await requireGit(source, ["add", "."]);
      await requireGit(source, [
        "-c",
        "user.name=Fixture",
        "-c",
        "user.email=fixture@example.invalid",
        "commit",
        "-m",
        "Fixture",
      ]);
    }
    const worktree =
      kind === "empty"
        ? await worktrees.createEmpty(owner)
        : await worktrees.create({ ...owner, repoRoot: source, runSetupScript: false });
    await writeSkill({
      dir: path.join(remote, "skills", "agent-only"),
      name: "agent-only",
      description: "Remote agent skill",
      body: "Node agent instructions",
    });
    await fs.writeFile(
      path.join(remote, "skills", "agent-only", "resource.txt"),
      "Node agent resource",
    );
    const policy = {
      allowReadPaths: [remote, remote + "/**"],
      allowWritePaths: [],
      denyPaths: [] as string[],
      followSymlinks: false,
      ask: "off",
    };
    const pluginConfig = {
      policyVersion: 2,
      workspaces: { main: { nodeId: "node-1", remoteRoot: remote } },
      nodes: { "node-1": policy },
    };
    const config = {
      agents: { entries: { main: { workspace: local, agentDir: path.join(stateDir, "agent") } } },
      plugins: { enabled: false, entries: { "file-transfer": { config: pluginConfig } } },
    };
    let service!: OpenClawPluginService;
    const api = createTestPluginApi({
      registrationMode: "full",
      config,
      pluginConfig,
      runtime: {
        agent: { resolveAgentWorkspaceDir: () => local },
      } as unknown as OpenClawPluginApi["runtime"],
      registerService(value) {
        service = value;
      },
    });
    registerNodeWorkspaces(api);
    const transport = createNodeWorkspaceTestTransport(api, remote);
    const requests: Array<{ operation: string; request: string }> = [];
    const context = {
      config,
      logger: api.logger,
      stateDir,
      invokeNode: vi.fn(),
      openNodeDuplex: async (...args: Parameters<typeof transport>) => {
        requests.push(args[0].params as { operation: string; request: string });
        return transport(...args);
      },
    };
    await service.start(context);
    const retainedReader = getAgentWorkspaceAccess(local)!.skillResources!;
    const entry: SessionEntry = {
      sessionId: kind,
      updatedAt: 1,
      worktree: {
        id: worktree.id,
        branch: worktree.branch,
        repoRoot: worktree.repoRoot,
        canonicalWorkspaceDir: worktree.repoRoot,
      },
    };
    try {
      const control = await ensureSkillSnapshot({
        agentId: "main",
        workspaceDir: local,
        cfg: config,
        isFirstTurnInSession: true,
      });
      expect(control.skillsSnapshot?.skills.some((skill) => skill.name === "agent-only")).toBe(
        true,
      );
      for (const isFirstTurnInSession of [true, false]) {
        const result = await ensureSkillSnapshot({
          agentId: "main",
          sessionEntry: entry,
          workspaceDir: local,
          executionWorkspaceDir: entry.worktree!.canonicalWorkspaceDir,
          cfg: config,
          isFirstTurnInSession,
        });
        const serializedSnapshot = JSON.stringify(result.skillsSnapshot);
        entry.skillsSnapshot = JSON.parse(serializedSnapshot);
        const agentSkill = result.skillsSnapshot?.resolvedSkills?.find(
          (skill) => skill.name === "agent-only",
        );
        expect(agentSkill).toMatchObject({
          filePath: path.join(remote, "skills", "agent-only", "SKILL.md"),
        });
        expect(resolveSkillFileHost(agentSkill!)).toBe("workspace");
        if (kind === "repository") {
          const projectSkill = result.skillsSnapshot?.resolvedSkills?.find(
            (skill) => skill.name === "project-only",
          );
          expect(projectSkill).toMatchObject({
            filePath: path.join(source, "skills", "project-only", "SKILL.md"),
          });
          expect(resolveSkillFileHost(projectSkill!)).toBe("gateway");
        }
        const delivery = await prepareSkillResourceDelivery(
          result.skillsSnapshot,
          () => {},
          [],
          local,
        );
        const materialized = await materializeSkillResources(delivery!, () => {});
        try {
          for (const skill of materialized.snapshot.resolvedSkills!.filter((s) =>
            ["agent-only", "project-only"].includes(s.name),
          )) {
            expect(await fs.readFile(skill.filePath, "utf8")).toContain(
              skill.name === "agent-only"
                ? "Node agent instructions"
                : "Gateway project instructions",
            );
            expect(await fs.readFile(path.join(skill.baseDir, "resource.txt"), "utf8")).toBe(
              skill.name === "agent-only" ? "Node agent resource" : "Gateway project resource",
            );
          }
        } finally {
          await materialized.cleanup();
        }
      }
      expect(requests.map((r) => r.operation)).toContain("watch");
      expect(requests.map((r) => r.operation)).toContain("discovery");
      for (const request of requests.filter((r) => ["watch", "discovery"].includes(r.operation))) {
        expect(request.request).not.toContain(worktree.repoRoot);
      }
      policy.denyPaths.push(path.join(remote, "skills", "agent-only", "SKILL.md"));
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
      await service.stop?.(context);
      await closeSkillsWatchers(true);
    }
    expect(() => getAgentWorkspaceAccess(local)).toThrow("stopped or not ready");
    await expect(
      retainedReader.readInstructions(path.join(remote, "skills", "agent-only", "SKILL.md"), {}),
    ).rejects.toThrow("stopped or not ready");
  },
  60_000,
);
