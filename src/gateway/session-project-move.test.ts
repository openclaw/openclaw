import { spawnSync } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { assert, expect, it } from "vitest";
import { makeUserMessage } from "../../test/helpers/user-message.js";
import { createSandboxTestContext } from "../agents/sandbox/test-fixtures.js";
import { SessionManager } from "../agents/sessions/session-manager.js";
import { requireGit } from "../agents/worktrees/git.js";
import { managedWorktrees } from "../agents/worktrees/service.js";
import { setRuntimeConfigSnapshot } from "../config/runtime-snapshot.js";
import { resolveSessionStorePathCore } from "../config/sessions/paths.js";
import {
  loadSessionEntryReadOnly,
  upsertSessionEntryCore,
} from "../config/sessions/session-accessor.js";
import { registerProjectRegistry } from "../projects/project-registry.js";
import { withEnvAsync } from "../test-utils/env.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { createDirectChatContext } from "./server-chat.agent-events.test-helpers.js";
import { prepareSessionWorkspaceForRun } from "./server-methods/session-create-project.js";
import { moveSessionIntoProject } from "./session-project-move.js";
import type { CarrySource } from "./session-workspace-carry.js";

const commit = ["-c", "user.name=Fixture", "-c", "user.email=fixture@example.test", "commit"];

it.each(["sandbox", "host"] as const)(
  "moves an unbound %s conversation into a project through the project open path, bringing its checkout work and running no agent or host Git programs",
  async (where) => {
    await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
      const cfg = { agents: { entries: { main: { workspace: state.workspaceDir } } } };
      setRuntimeConfigSnapshot(cfg);
      const repoRoot = path.join(state.root, "project");
      await fs.mkdir(repoRoot);
      await requireGit(repoRoot, ["init", "-b", "main"]);
      await fs.writeFile(path.join(repoRoot, "kept.txt"), "kept\n");
      await fs.writeFile(path.join(repoRoot, "removed.txt"), "removed\n");
      await requireGit(repoRoot, ["add", "."]);
      await requireGit(repoRoot, [...commit, "-m", "Project base"]);
      const origin = "https://github.com/example/carry.git";
      await requireGit(repoRoot, ["remote", "add", "origin", origin]);
      const gitConfig = path.join(state.root, "transport.gitconfig");
      await requireGit(repoRoot, [
        "config",
        "--file",
        gitConfig,
        `url.${pathToFileURL(repoRoot).href}.insteadOf`,
        origin,
      ]);
      const project = await registerProjectRegistry({ path: repoRoot, name: "carry" });

      // The conversation cloned the project into its own workspace and kept working there.
      const clone = path.join(state.workspaceDir, "work");
      await requireGit(state.workspaceDir, ["clone", "--quiet", repoRoot, clone]);
      await fs.writeFile(path.join(clone, "feature.txt"), "committed work\n");
      await requireGit(clone, ["add", "feature.txt"]);
      // A committed link to a host file, replaced by a plain file before the move.
      const victim = path.join(state.root, "victim.txt");
      await fs.writeFile(victim, "host file\n");
      await fs.symlink(victim, path.join(clone, "link"));
      await requireGit(clone, ["add", "link"]);
      await requireGit(clone, [...commit, "-m", "Committed work"]);
      const carriedCommit = await requireGit(clone, ["rev-parse", "HEAD"]);
      await fs.rm(path.join(clone, "link"));
      await fs.writeFile(path.join(clone, "link"), "replaced, not saved\n");
      await fs.writeFile(path.join(clone, "kept.txt"), "edited, not saved\n");
      await fs.writeFile(path.join(clone, "draft.txt"), "new, not saved\n");
      await fs.rm(path.join(clone, "removed.txt"));
      // Unsaved attributes name a filter that the agent's clone, the project and the
      // user's Git config each define; the host must run none of them.
      const markers = ["clone", "project", "global"].map((scope) =>
        path.join(state.root, `filter-ran-${scope}`),
      );
      await requireGit(clone, ["config", "filter.carry.clean", `touch ${markers[0]}; cat`]);
      await requireGit(repoRoot, ["config", "filter.carry.smudge", `touch ${markers[1]}; cat`]);
      await requireGit(repoRoot, [
        "config",
        "--file",
        gitConfig,
        "filter.carry.smudge",
        `touch ${markers[2]}; cat`,
      ]);
      await fs.writeFile(path.join(clone, ".gitattributes"), "*.txt filter=carry\n");

      const target = {
        agentId: "main",
        sessionKey: "agent:main:carry",
        storePath: resolveSessionStorePathCore(undefined, { agentId: "main" }),
      };
      await upsertSessionEntryCore(target, {
        sessionId: "carry",
        updatedAt: 1,
        sessionRoot: state.workspaceDir,
      });
      const manager = await SessionManager.openAsync(
        { ...target, sessionId: "carry" },
        state.workspaceDir,
      );
      await manager.appendMessageAsync(makeUserMessage("Publish my work", 1));
      // A fake sandbox runs the in-sandbox script on this machine, where its container path
      // is the workspace. Its git sees only an empty global config, like a fresh container.
      const sandboxGit = path.join(state.root, "sandbox.gitconfig");
      await fs.writeFile(sandboxGit, "");
      const source: CarrySource =
        where === "host"
          ? { kind: "host", workspaceDir: state.workspaceDir }
          : {
              kind: "sandbox",
              sandbox: {
                ...createSandboxTestContext({
                  overrides: {
                    sessionKey: target.sessionKey,
                    workspaceDir: state.workspaceDir,
                    containerWorkdir: state.workspaceDir,
                    workspaceSource: undefined,
                  },
                }),
                backend: {
                  runShellCommand: async (params: { script: string; args?: string[] }) => {
                    const run = spawnSync(
                      "sh",
                      ["-c", params.script, "carry", ...(params.args ?? [])],
                      {
                        maxBuffer: 64 * 1024 * 1024,
                        env: { ...process.env, GIT_CONFIG_GLOBAL: sandboxGit },
                      },
                    );
                    return { stdout: run.stdout, stderr: run.stderr, code: run.status ?? 1 };
                  },
                },
              } as never,
            };
      const context = createDirectChatContext({ getRuntimeConfig: () => cfg });
      // An owner run: no operator drives it, so the Gateway itself asks.
      const move = (projectId = project.id) =>
        moveSessionIntoProject({
          context,
          session: { ...target, sessionId: "carry" },
          carrySource: source,
          projectId,
          checkout: "work",
          requester: undefined,
          assertCurrent() {},
        });

      await withEnvAsync({ GIT_CONFIG_GLOBAL: gitConfig, GIT_ALLOW_PROTOCOL: "file" }, async () => {
        expect(await move()).toEqual({
          status: "pending",
          projectId: project.id,
          carried: { commit: carriedCommit, unsavedFiles: 5 },
        });
        // The move only records intent, exactly like a session created in the project.
        const pending = loadSessionEntryReadOnly(target);
        assert(pending);
        expect(pending).toMatchObject({
          projectId: project.id,
          pendingWorktree: {
            workspace: project.repoRoot,
            source: { kind: "project", id: project.id },
            baseCommit: carriedCommit,
          },
        });
        expect(pending.worktree).toBeUndefined();
        await expect(move("another")).rejects.toThrow("moves into a project only once");

        // The next turn opens it through the project open path.
        await prepareSessionWorkspaceForRun({
          ...target,
          entry: pending,
          cfg,
          runId: "next-turn",
          context,
          signal: new AbortController().signal,
          assertCurrent() {},
          runSetupScript: false,
        });
        const worktree = await managedWorktrees.findLiveByOwner("session", target.sessionKey);
        assert(worktree, "The next turn must open a managed project checkout");
        expect(loadSessionEntryReadOnly(target)).toMatchObject({
          projectId: project.id,
          sessionRoot: worktree.path,
          worktree: { id: worktree.id },
          priorWorkspace: { worktreeId: worktree.id, workspaceDir: state.workspaceDir },
        });
        expect(loadSessionEntryReadOnly(target)?.pendingWorktree).toBeUndefined();
        expect(await requireGit(worktree.path, ["rev-parse", "HEAD"])).toBe(carriedCommit);
        // In a sandbox the clone's own filter runs there, as the agent; never on the host.
        for (const marker of where === "host" ? markers : markers.slice(1)) {
          await expect(fs.stat(marker), marker).rejects.toMatchObject({ code: "ENOENT" });
        }
        // The new checkout replaces its committed link; it never writes through it.
        expect(await fs.readFile(victim, "utf8")).toBe("host file\n");
        for (const [file, text] of [
          ["link", "replaced, not saved\n"],
          ["kept.txt", "edited, not saved\n"],
          ["draft.txt", "new, not saved\n"],
        ]) {
          expect(await fs.readFile(path.join(worktree.path, file!), "utf8")).toBe(text);
        }
        await expect(fs.stat(path.join(worktree.path, "removed.txt"))).rejects.toMatchObject({
          code: "ENOENT",
        });
        // Unsaved work stays unsaved, and the private transfer refs are gone.
        expect(await requireGit(worktree.path, ["status", "--porcelain"])).toContain("draft.txt");
        for (const repo of [repoRoot, clone]) {
          expect(
            await requireGit(repo, ["for-each-ref", "--format=%(refname)", "refs/openclaw"]),
          ).toBe("");
        }
      });
    });
  },
);
