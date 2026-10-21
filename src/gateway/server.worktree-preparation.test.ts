import fs from "node:fs/promises";
import path from "node:path";
import { expect, it } from "vitest";
import { resolveBootstrapContextForRun } from "../agents/bootstrap-files.js";
import { requireGit } from "../agents/worktrees/git.js";
import { getRegistryWorktree } from "../agents/worktrees/registry.test-support.js";
import { setRuntimeConfigSnapshot } from "../config/runtime-snapshot.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import bootstrapExtraFilesHook from "../hooks/bundled/bootstrap-extra-files/handler.js";
import { registerInternalHook, unregisterInternalHook } from "../hooks/internal-hooks.js";
import { createDeferredCore } from "../shared/deferred.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { prepareSessionWorktree } from "./session-worktree-preparation.js";

// Gateway fork workers own the shared-state broker required by real worktree preparation.
it.each([
  { name: "sandbox", sandboxRequired: true, hookEvent: undefined },
  { name: "configured bootstrap", sandboxRequired: false, hookEvent: "agent:bootstrap" },
  { name: "family bootstrap listener", sandboxRequired: false, hookEvent: "agent" },
])(
  "finishes the $name worktree before exposing its prompt",
  async ({ sandboxRequired, hookEvent }) => {
    await withOpenClawTestState({ label: "complete-worktree-prompt" }, async (state) => {
      const workspace = state.workspaceDir;
      await fs.mkdir(workspace, { recursive: true });
      await requireGit(workspace, ["init", "-b", "main"]);
      await requireGit(workspace, ["config", "user.name", "Workspace Fixture"]);
      await requireGit(workspace, ["config", "user.email", "fixture@example.invalid"]);
      for (const [file, content] of [
        ["AGENTS.md", "Committed instructions.\n"],
        ["src/remaining.txt", "Complete checkout.\n"],
        ["packages/core/AGENTS.md", "Nested project rules.\n"],
      ] as const) {
        const destination = path.join(workspace, file);
        await fs.mkdir(path.dirname(destination), { recursive: true });
        await fs.writeFile(destination, content);
      }
      await requireGit(workspace, ["add", "."]);
      await requireGit(workspace, ["commit", "-qm", "prompt fixture"]);

      const promptExposed = createDeferredCore();
      const releaseCheckout = createDeferredCore();
      const bootstrapFiles = { enabled: true, paths: ["packages/*/AGENTS.md"] };
      const cfg: OpenClawConfig = {
        agents: { defaults: { workspace } },
        worktreeAcceleration: false,
        hooks: { internal: { entries: { "bootstrap-extra-files": bootstrapFiles } } },
      };
      setRuntimeConfigSnapshot(cfg);
      if (hookEvent) {
        registerInternalHook(hookEvent, bootstrapExtraFilesHook);
      }
      const preparing = prepareSessionWorktree({
        cfg,
        target: {
          agentId: "main",
          key: "agent:main:sandbox-worktree",
          storePath: path.join(state.sessionsDir(), "sessions.sqlite"),
          sandboxRequired,
        },
        workspace,
        baseRef: "HEAD",
        runSetupScript: false,
        onPromptReady: async () => {
          promptExposed.resolve();
          await releaseCheckout.promise;
        },
      });
      try {
        const first = await Promise.race([
          preparing.then(() => "prepared"),
          promptExposed.promise.then(() => "early prompt"),
        ]);
        expect(first).toBe("prepared");
        const prepared = await preparing;
        expect(prepared.ok, JSON.stringify(prepared)).toBe(true);
        if (!prepared.ok || !prepared.value.worktree || !prepared.value.spawnedCwd) {
          throw new Error("Expected a published worktree");
        }
        expect(getRegistryWorktree(process.env, prepared.value.worktree.id)).toMatchObject({
          ownerKind: "session",
          ownerId: "agent:main:sandbox-worktree",
        });
        expect(
          await fs.readFile(path.join(prepared.value.spawnedCwd, "src/remaining.txt"), "utf8"),
        ).toBe("Complete checkout.\n");
        if (hookEvent) {
          const bootstrap = await resolveBootstrapContextForRun({
            workspaceDir: prepared.value.spawnedCwd,
            config: cfg,
            agentId: "main",
            sessionKey: "agent:main:sandbox-worktree",
          });
          expect(bootstrap.contextFiles).toContainEqual({
            path: path.join(prepared.value.spawnedCwd, "packages/core/AGENTS.md"),
            content: "Nested project rules.",
          });
        }
      } finally {
        if (hookEvent) {
          unregisterInternalHook(hookEvent, bootstrapExtraFilesHook);
        }
        releaseCheckout.resolve();
        const prepared = await preparing;
        if (prepared.ok) {
          await prepared.value.rollback?.();
        }
      }
    });
  },
);
