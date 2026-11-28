import { spawnSync } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { assert, expect, it, vi } from "vitest";
import { makeUserMessage } from "../../test/helpers/user-message.js";
import type { SandboxBackendHandle } from "../agents/sandbox/backend-handle.types.js";
import * as sandboxRuntime from "../agents/sandbox/context.js";
import { createSandboxTestContext } from "../agents/sandbox/test-fixtures.js";
import { SessionManager } from "../agents/sessions/session-manager.js";
import { withGatewayToolCallerIdentity } from "../agents/tools/gateway-caller-context.js";
import { createSessionProjectTool } from "../agents/tools/session-project-tool.js";
import { requireGit } from "../agents/worktrees/git.js";
import { managedWorktrees } from "../agents/worktrees/service.js";
import { createTestReplyOperation } from "../auto-reply/reply/reply-run-registry.test-helpers.js";
import * as sessionEvents from "../auto-reply/reply/session-event-handoff.js";
import { setRuntimeConfigSnapshot } from "../config/runtime-snapshot.js";
import { resolveSessionStorePathCore } from "../config/sessions/paths.js";
import {
  loadSessionEntryReadOnly,
  upsertSessionEntryCore,
} from "../config/sessions/session-accessor.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { withPluginRuntimeGatewayRequestScope } from "../plugins/runtime/gateway-request-scope.js";
import { registerProjectRegistry } from "../projects/project-registry.js";
import { withSessionControllerOwner } from "../sessions/session-controller.context.js";
import { captureSessionTarget } from "../sessions/session-controller.target.js";
import { createDeferredCore } from "../shared/deferred.js";
import { withEnvAsync } from "../test-utils/env.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { createDirectChatContext } from "./server-chat.agent-events.test-helpers.js";
import { withOperatorToolGatewayAuthority } from "./server-plugin-in-process-dispatch.js";
import { moveSessionIntoProject } from "./session-project-move.js";
import { listCarryCheckouts, type CarrySource } from "./session-workspace-carry.js";

const commit = ["-c", "user.name=Fixture", "-c", "user.email=fixture@example.test", "commit"];

it.each([
  [{ session: { mainKey: "home" } }, "agent:qa:home"],
  [{ session: { mainKey: "home" } }, "main"],
  [{ session: { scope: "global" } }, "global"],
] as const)(
  "refuses a retained model move before yielding Home (%s, %s)",
  async (cfg, sessionKey) => {
    const context = createDirectChatContext({ getRuntimeConfig: () => cfg });
    const caller = { agentId: "qa", sessionKey };
    await withPluginRuntimeGatewayRequestScope(
      { context, resolveGatewayContext: () => context, isWebchatConnect: () => false },
      () =>
        withGatewayToolCallerIdentity(caller, () =>
          expect(
            createSessionProjectTool({ senderIsOwner: true, sessionId: "fixture" }).execute(
              "retained-move",
              { action: "move", projectId: "fixture" },
            ),
          ).rejects.toThrow("Home"),
        ),
    );
  },
);

it("refuses an SSH sandbox move before changing the stored conversation", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
    const cfg: OpenClawConfig = {
      agents: {
        defaults: { sandbox: { mode: "all", backend: "ssh", workspaceAccess: "rw" } },
        entries: { main: { workspace: state.workspaceDir } },
      },
    };
    setRuntimeConfigSnapshot(cfg);
    const repoRoot = path.join(state.root, "project");
    await fs.mkdir(repoRoot);
    await requireGit(repoRoot, ["init", "-b", "main"]);
    await requireGit(repoRoot, [...commit, "--allow-empty", "-m", "Project base"]);
    const project = await registerProjectRegistry({ path: repoRoot, name: "project" });
    const target = {
      agentId: "main",
      sessionKey: "agent:main:chat:move",
      storePath: resolveSessionStorePathCore(undefined, { agentId: "main" }),
    };
    const sessionId = "move";
    await upsertSessionEntryCore(target, {
      sessionId,
      updatedAt: 1,
      sessionRoot: state.workspaceDir,
    });
    const manager = await SessionManager.openAsync({ ...target, sessionId }, state.workspaceDir);
    await manager.appendMessageAsync(makeUserMessage("Move into the project", 1));
    const context = createDirectChatContext({ getRuntimeConfig: () => cfg });

    await expect(
      moveSessionIntoProject({
        context,
        session: target,
        carrySource: { kind: "host", workspaceDir: state.workspaceDir },
        projectId: project.id,
        requester: undefined,
        assertCurrent() {},
      }),
    ).rejects.toThrow("Docker or Podman");
    const entry = loadSessionEntryReadOnly(target);
    expect(entry).toMatchObject({ sessionId, sessionRoot: state.workspaceDir });
    expect(entry?.projectId).toBeUndefined();
    expect(entry?.pendingWorktree).toBeUndefined();
    expect(entry?.worktree).toBeUndefined();
  });
});

it.each([
  ["sandbox", "operator.admin", false],
  ["sandbox", "operator.admin", true],
  ["host", "operator.admin", false],
  ["host", "operator.write", false],
] as const)(
  "handles an unbound %s conversation with %s (unavailable project: %s)",
  async (where, requesterScope, unavailableProject) => {
    await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
      const cfg = { agents: { entries: { main: { workspace: state.workspaceDir } } } };
      setRuntimeConfigSnapshot(cfg);
      const repoRoot = path.join(state.root, "project");
      await fs.mkdir(repoRoot);
      await requireGit(repoRoot, ["init", "-b", "main"]);
      await fs.writeFile(path.join(repoRoot, "kept.txt"), "kept\n");
      await fs.writeFile(path.join(repoRoot, "removed.txt"), "removed\n");
      await fs.mkdir(path.join(repoRoot, ".openclaw"));
      await fs.writeFile(
        path.join(repoRoot, ".openclaw", "worktree-setup.sh"),
        '#!/bin/sh\nset -e\ntest "$(cat kept.txt)" = "edited, not saved"\ntest -f draft.txt\nprintf ready > setup-result\n',
        { mode: 0o755 },
      );
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
      await requireGit(clone, ["remote", "set-url", "origin", origin]);
      await requireGit(clone, ["switch", "-c", "conversation"]);
      await requireGit(repoRoot, [...commit, "--allow-empty", "-m", "Project advances"]);
      const projectTip = await requireGit(repoRoot, ["rev-parse", "HEAD"]);
      await requireGit(repoRoot, ["update-ref", "refs/remotes/origin/main", projectTip]);
      await expect(requireGit(clone, ["cat-file", "-e", projectTip])).rejects.toThrow();
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
      let turnActive = true;
      const sandboxWithAuthority = (assertCurrent: () => void) => {
        const runShellCommand: SandboxBackendHandle["runShellCommand"] = async (params) => {
          assertCurrent();
          const run = spawnSync("sh", ["-c", params.script, "carry", ...(params.args ?? [])], {
            input: params.stdin,
            maxBuffer: 64 * 1024 * 1024,
            env: { ...process.env, GIT_CONFIG_GLOBAL: sandboxGit },
          });
          return { stdout: run.stdout, stderr: run.stderr, code: run.status ?? 1 };
        };
        return createSandboxTestContext({
          overrides: {
            sessionKey: target.sessionKey,
            agentWorkspaceDir: state.workspaceDir,
            workspaceDir: state.workspaceDir,
            containerWorkdir: state.workspaceDir,
            backend: {
              id: "docker",
              runtimeId: "fixture",
              runtimeLabel: "fixture",
              workdir: state.workspaceDir,
              buildExecSpec: async () => {
                throw new Error("The carry fixture only accepts shell scripts");
              },
              runShellCommand,
            },
          },
        });
      };
      const sandbox = sandboxWithAuthority(() => {
        if (!turnActive) {
          throw new Error("Initiating turn's sandbox authority has ended");
        }
      });
      const source: CarrySource =
        where === "host"
          ? { kind: "host", workspaceDir: state.workspaceDir }
          : { kind: "sandbox", sandbox };
      const context = createDirectChatContext({ getRuntimeConfig: () => cfg });
      context.resolveGatewayContext = () => context;
      const move = (projectId = project.id) =>
        moveSessionIntoProject({
          context,
          session: target,
          carrySource: source,
          projectId,
          checkout: "work",
          requester: { profileId: undefined, scopes: [requesterScope] },
          assertCurrent() {},
        });

      await withEnvAsync({ GIT_CONFIG_GLOBAL: gitConfig, GIT_ALLOW_PROTOCOL: "file" }, async () => {
        expect(await listCarryCheckouts(source)).toEqual([
          { path: "work", originUrl: origin, commit: carriedCommit, unsavedFiles: 5 },
        ]);
        let branch: string | undefined;
        if (where === "sandbox") {
          const runId = "move-handoff";
          const operation = createTestReplyOperation({
            sessionKey: target.sessionKey,
            sessionId: "carry",
            target: captureSessionTarget({
              storeScope: target.storePath,
              agentId: target.agentId,
              sessionKey: target.sessionKey,
              incarnation: "carry",
            }),
          });
          operation.setPhase("running");
          operation.attachBackend({ kind: "embedded", runId, cancel() {} });
          const settled = createDeferredCore();
          const resumed = createDeferredCore<string>();
          const acquire = vi
            .spyOn(sandboxRuntime, "resolveSandboxContext")
            .mockImplementation(async ({ assertCurrent }) => {
              assert(assertCurrent);
              return sandboxWithAuthority(assertCurrent);
            });
          const enqueue = vi
            .spyOn(sessionEvents, "enqueueSessionEventForHost")
            .mockImplementation((text) => {
              resumed.resolve(text);
              return {
                id: "carry-result",
                cancel: () => false,
                accepted: Promise.resolve({ ok: true }),
                settled: Promise.resolve({
                  status: "completed",
                  executionStarted: true,
                  delivered: false,
                }),
              };
            });
          try {
            await withPluginRuntimeGatewayRequestScope(
              { context, resolveGatewayContext: () => context, isWebchatConnect: () => false },
              () =>
                withOperatorToolGatewayAuthority(
                  { scopes: ["operator.admin"], operatorRoleActor: { kind: "system" } },
                  () =>
                    withGatewayToolCallerIdentity(target, () =>
                      withSessionControllerOwner(operation, async () => {
                        const result = await createSessionProjectTool({
                          sandbox,
                          sessionId: "carry",
                          runId,
                          senderIsOwner: true,
                          onYield: () => operation.completeWithAfterClearBarrier(settled.promise),
                        }).execute("move-project", {
                          action: "move",
                          projectId: unavailableProject ? "unregistered" : project.id,
                          checkout: "work",
                        });
                        expect(result.details).toMatchObject({ status: "started" });
                      }),
                    ),
                ),
            );
            turnActive = false;
            settled.resolve();
            const message = await resumed.promise;
            const completed = enqueue.mock.calls[0]?.[1].completedToolCall;
            if (unavailableProject) {
              expect(message).toContain("Project unregistered is not available to you");
              expect(message).not.toContain("Moved this conversation");
              expect(completed).toBeUndefined();
              expect(loadSessionEntryReadOnly(target)?.sessionRoot).toBe(state.workspaceDir);
              return;
            }
            expect(message).toContain('"status":"moved"');
            expect(message).toContain(`"commit":"${carriedCommit}"`);
            expect(completed?.id).toBe("move-project");
            expect(JSON.parse(completed?.result ?? "null")).toMatchObject({
              status: "moved",
              projectId: project.id,
              carried: { commit: carriedCommit },
            });
          } finally {
            settled.resolve();
            operation.complete();
            acquire.mockRestore();
            enqueue.mockRestore();
          }
        } else {
          const moved = await move();
          expect(moved).toMatchObject({
            status: "moved",
            projectId: project.id,
            carried: { commit: carriedCommit, unsavedFiles: 5 },
          });
          branch = moved.branch;
        }
        await expect(move("another")).rejects.toThrow("moves into a project only once");
        const worktree = await managedWorktrees.findLiveByOwner("session", target.sessionKey);
        assert(worktree, "The move must open a managed project checkout");
        if (where === "host") {
          expect(branch).toBe(worktree.branch);
          const setup = fs.readFile(path.join(worktree.path, "setup-result"), "utf8");
          if (requesterScope === "operator.admin") {
            await expect(setup).resolves.toBe("ready");
          } else {
            await expect(setup).rejects.toMatchObject({ code: "ENOENT" });
          }
        }
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
