import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import {
  resolveManagedGitHubProfileDir,
  writeManagedGitHubProfileFiles,
} from "../agents/github-tool-identity.js";
import { requireGit } from "../agents/worktrees/git.js";
import { managedWorktrees } from "../agents/worktrees/service.js";
import { getRuntimeConfig } from "../config/io.js";
import { setRuntimeConfigSnapshot } from "../config/runtime-snapshot.js";
import type { SessionEntry } from "../config/sessions/types.js";
import * as processExec from "../process/exec.js";
import { getSessionWorkAdmissionRelease } from "../sessions/session-lifecycle-admission.js";
import { closeOpenClawStateDatabaseAsync } from "../state/openclaw-state-db.js";
import type { ChatAbortControllerEntry } from "./chat-abort.js";
import { controlUiClient } from "./server.sessions.create.projects.test-support.js";
import { loadGatewaySessionEntryReadOnly } from "./session-utils-store.js";
import { dispatchInboundMessageMock } from "./test-helpers.js";
import {
  directSessionReq,
  setupGatewaySessionsHandlerTestHarness,
} from "./test/server-sessions.test-helpers.js";
import {
  AUTHORIZATION,
  TOKEN,
  URL as REPOSITORY_URL,
  fixture,
} from "./worker-environments/repository-git-pack.test-support.js";

vi.mock("../agents/github-oauth-client.js", () => ({
  verifyGitHubCredential: async () => ({
    status: "available",
    account: { accountId: 123, login: "fixture" },
  }),
}));

afterEach(async () => {
  dispatchInboundMessageMock.mockReset();
  await closeOpenClawStateDatabaseAsync();
});

const { createSessionStoreDir } = setupGatewaySessionsHandlerTestHarness();

test.each(
  (["clone", "refresh"] as const).flatMap((operation) =>
    (["allowed", "replaced", "retired", "rotated"] as const).map((identity) => ({
      operation,
      identity,
    })),
  ),
)(
  "sessions.create fences $operation Git effects when its identity is $identity",
  async ({ operation, identity }) => {
    const git = await fixture({ setupRecipe: false });
    vi.stubEnv("OPENCLAW_STATE_DIR", git.root);
    vi.stubEnv("GH_TOKEN", "");
    vi.stubEnv("GITHUB_TOKEN", "");
    const { storePath } = await createSessionStoreDir();
    const profileId = "ghp_11111111111111111111111111111111";
    await writeManagedGitHubProfileFiles(
      resolveManagedGitHubProfileDir({ agentId: "main", scope: "system", profileId }),
      { login: "fixture", token: TOKEN },
    );
    const selected = {
      ...getRuntimeConfig(),
      gateway: { projects: { nativeGitHubSearch: true } },
      tools: { github: { profileId } },
    };
    setRuntimeConfigSnapshot(selected);
    const runCommand = processExec.runCommandWithTimeout;
    vi.spyOn(processExec, "runCommandWithTimeout").mockImplementation((argv, options) => {
      if (
        argv[0] !== "git" ||
        !argv.some((arg) => arg === REPOSITORY_URL || arg === git.endpoint)
      ) {
        return runCommand(argv, options);
      }
      // Translate HTTPS into this owned authenticated endpoint; the production
      // Git command, selected credential, retry admission and object transfer remain real.
      const commandOptions = typeof options === "number" ? { timeoutMs: options } : options;
      return runCommand(
        argv.map((arg) => (arg === REPOSITORY_URL ? git.endpoint : arg)),
        {
          ...commandOptions,
          env: { ...commandOptions.env, GIT_CONFIG_KEY_0: `http.${git.endpoint}/.extraHeader` },
        },
      );
    });
    dispatchInboundMessageMock.mockResolvedValue({
      queuedFinal: false,
      counts: { block: 0, final: 0, tool: 0 },
    });
    const broadcast = vi.fn();
    const context = {
      broadcast,
      chatAbortControllers: new Map<string, ChatAbortControllerEntry>(),
    };
    let sequence = 0;
    const errors = () =>
      JSON.stringify(
        broadcast.mock.calls
          .filter(([event, data]) => event === "chat" && data.state === "error")
          .map(([, data]) => data.errorMessage),
      );
    const create = async (worktree = false) => {
      const created = await directSessionReq<{ key: string; runId: string; entry: SessionEntry }>(
        "sessions.create",
        {
          agentId: "main",
          label: `Identity proof ${sequence++}`,
          message: "Inspect the repository",
          projectGitUrl: REPOSITORY_URL,
          ...(worktree
            ? {
                worktree: true,
                worktreeName: "identity-proof",
                worktreeBaseRef: "origin/fresh-base",
              }
            : {}),
        },
        { ...controlUiClient, context },
      );
      expect(created.ok, JSON.stringify(created.error)).toBe(true);
      expect(created.payload).toMatchObject({ runStarted: true });
      const { key, runId } = created.payload!;
      const target = loadGatewaySessionEntryReadOnly(key, { agentId: "main" });
      const released = getSessionWorkAdmissionRelease({
        scope: target.storePath,
        identities: [key],
      });
      await released;
      expect(context.chatAbortControllers.has(runId)).toBe(false);
      const entry = loadGatewaySessionEntryReadOnly(key, { agentId: "main" }).entry;
      expect(
        entry,
        JSON.stringify({
          key,
          storePath,
          events: broadcast.mock.calls.map(([event, data]) => ({
            event,
            state: data?.state,
            error: data?.errorMessage,
          })),
        }),
      ).toBeDefined();
      return {
        key,
        runId,
        entry,
      };
    };
    if (operation === "refresh") {
      const warm = await create();
      expect(warm.entry?.projectId, errors()).toBeDefined();
      await requireGit(path.join(git.root, "remote.git"), ["branch", "fresh-base", git.later]);
      git.requests.length = 0;
      dispatchInboundMessageMock.mockClear();
    }
    let reachedBoundary = false;
    const revoke = async () => {
      reachedBoundary = true;
      if (identity === "replaced") {
        setRuntimeConfigSnapshot({
          ...selected,
          tools: { github: { profileId: "ghp_22222222222222222222222222222222" } },
        });
      } else if (identity === "retired") {
        setRuntimeConfigSnapshot({ ...selected, tools: {} });
      } else if (identity === "rotated") {
        await writeManagedGitHubProfileFiles(
          resolveManagedGitHubProfileDir({ agentId: "main", scope: "system", profileId }),
          { login: "fixture", token: `${TOKEN}-rotated` },
        );
      }
    };
    if (operation === "clone") {
      const mkdir = fs.mkdir;
      vi.spyOn(fs, "mkdir").mockImplementation(async (target, options) => {
        const result = await mkdir(target, options);
        if (String(target).startsWith(path.join(git.root, "projects") + path.sep)) {
          await revoke();
        }
        return result;
      });
    } else {
      const mkdtemp = fs.mkdtemp;
      vi.spyOn(fs, "mkdtemp").mockImplementation(async (prefix, options) => {
        const result = await mkdtemp(prefix, options);
        if (prefix.includes("openclaw-project-fetch-")) {
          await revoke();
        }
        return result;
      });
    }
    const created = await create(operation === "refresh");
    expect(reachedBoundary).toBe(true);
    if (identity === "allowed") {
      expect(git.requests.length).toBeGreaterThan(0);
      expect(git.requests.every((authorization) => authorization === AUTHORIZATION)).toBe(true);
      expect(created.entry?.projectId, errors()).toBeDefined();
      expect(dispatchInboundMessageMock).toHaveBeenCalledOnce();
      expect(await fs.readFile(path.join(created.entry!.spawnedCwd!, "input.txt"), "utf8")).toBe(
        "later private content\n",
      );
      if (created.entry?.worktree) {
        await managedWorktrees.remove({
          id: created.entry.worktree.id,
          reason: "test-cleanup",
          allowSnapshotLoss: true,
        });
      }
    } else {
      expect(git.requests).toEqual([]);
      expect(created.entry?.projectId).toBeUndefined();
      expect(dispatchInboundMessageMock).not.toHaveBeenCalled();
      expect(broadcast).toHaveBeenCalledWith(
        "chat",
        expect.objectContaining({
          runId: created.runId,
          state: "error",
          errorMessage: expect.stringContaining("GitHub"),
        }),
        expect.anything(),
      );
    }
  },
);
