import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  loadSessionEntry,
  upsertSessionEntryCore,
} from "../../config/sessions/session-accessor.js";
import { closeOpenClawAgentDatabasesForTest } from "../../state/openclaw-agent-db.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { initializeRepository } from "../server.sessions.create.projects.test-support.js";
import {
  call,
  dismissPendingTaskSuggestions,
  operatorClient,
  requirePayload,
  SOURCE_SESSION_KEY,
} from "./task-suggestions.test-support.js";
import type { RespondFn } from "./types.js";

const mocks = vi.hoisted(() => ({ handleChatSend: vi.fn() }));
vi.mock("./chat-send-handler.js", () => ({ handleChatSend: mocks.handleChatSend }));

beforeEach(async () => {
  await dismissPendingTaskSuggestions();
  mocks.handleChatSend.mockReset();
  mocks.handleChatSend.mockImplementation(async ({ respond }: { respond: RespondFn }) => {
    respond(true, { runId: "suggested-task-run", status: "started" }, undefined);
  });
});

afterEach(async () => {
  await dismissPendingTaskSuggestions();
  closeOpenClawAgentDatabasesForTest();
});

describe("session-first task suggestion acceptance", () => {
  it("keeps an unborn-repository suggestion retryable and starts it once from the corrected repository", async () => {
    await withOpenClawTestState({ scenario: "minimal" }, async ({ root, workspaceDir }) => {
      const cwd = await fs.realpath(workspaceDir);
      await promisify(execFile)("git", ["init", "-b", "main", cwd]);
      const repository = await initializeRepository(root, "project");
      const prompt = "Investigate the service shutdown using retained evidence.";
      const config = { agents: { defaults: { workspace: cwd } } };
      const options = {
        config,
        client: operatorClient(),
        context: {
          loadGatewayModelCatalog: async () => [],
          getSessionEventSubscriberConnIds: () => new Set<string>(),
        },
      };
      await upsertSessionEntryCore(
        { agentId: "main", sessionKey: SOURCE_SESSION_KEY },
        { sessionId: "source-recovery", updatedAt: 1 },
      );
      const { taskId } = requirePayload(
        await call(
          "taskSuggestions.create",
          {
            title: "Investigate shutdown",
            prompt,
            tldr: "A service stopped unexpectedly.",
            cwd,
            sessionKey: SOURCE_SESSION_KEY,
          },
          vi.fn(),
          options,
        ),
      ) as { taskId: string };

      const rejected = await call(
        "taskSuggestions.accept",
        { taskId, mode: "worktree" },
        vi.fn(),
        options,
      );
      expect(rejected.response).toMatchObject([
        false,
        undefined,
        {
          code: "INVALID_REQUEST",
          details: { code: "TASK_WORKTREE_SOURCE_REQUIRED", cwd },
        },
      ]);
      expect(mocks.handleChatSend).not.toHaveBeenCalled();
      expect(
        requirePayload(await call("taskSuggestions.list", {}, vi.fn(), options)),
      ).toMatchObject({
        suggestions: [expect.objectContaining({ id: taskId, cwd, prompt })],
      });

      const correction = { taskId, mode: "worktree", cwd: repository };
      const accepted = await call("taskSuggestions.accept", correction, vi.fn(), options);
      expect(accepted.response?.[2]).toBeUndefined();
      const { key } = requirePayload(accepted) as { key: string };
      expect(loadSessionEntry({ agentId: "main", sessionKey: key })).toMatchObject({
        pendingWorktree: { workspace: repository },
        parentSessionKey: SOURCE_SESSION_KEY,
      });
      expect(mocks.handleChatSend).toHaveBeenCalledTimes(1);
      expect(mocks.handleChatSend.mock.calls[0]?.[0]).toMatchObject({
        params: { sessionKey: key, message: prompt },
      });
      expect(
        requirePayload(await call("taskSuggestions.accept", correction, vi.fn(), options)),
      ).toEqual({ taskId, key });
      expect(mocks.handleChatSend).toHaveBeenCalledTimes(1);
      await expect(
        promisify(execFile)("git", ["-C", cwd, "rev-parse", "--verify", "HEAD"]),
      ).rejects.toBeDefined();
    });
  });

  it.each(["plain folder", "unavailable Git metadata"])(
    "starts a follow-up without worktree setup: %s",
    async (scenario) => {
      await withOpenClawTestState({ scenario: "minimal" }, async ({ workspaceDir }) => {
        const cwd = await fs.realpath(workspaceDir);
        const gitMarker = path.join(cwd, ".git");
        const brokenGit = "gitdir: /missing/follow-up-repository\n";
        if (scenario === "unavailable Git metadata") {
          await fs.writeFile(gitMarker, brokenGit);
        }
        const prompt = "Investigate the restarting local service without changing storage.";
        const config = { agents: { defaults: { workspace: cwd } } };
        await upsertSessionEntryCore(
          { agentId: "main", sessionKey: SOURCE_SESSION_KEY },
          { sessionId: "follow-up-source", updatedAt: 1 },
        );
        const created = await call(
          "taskSuggestions.create",
          {
            title: "Investigate a local service",
            prompt,
            tldr: "A local service is restarting repeatedly.",
            cwd,
            sessionKey: SOURCE_SESSION_KEY,
          },
          vi.fn(),
          { config },
        );
        const { taskId } = requirePayload(created) as { taskId: string };
        const accepted = await call("taskSuggestions.accept", { taskId, mode: "local" }, vi.fn(), {
          config,
          context: {
            loadGatewayModelCatalog: async () => [],
            getSessionEventSubscriberConnIds: () => new Set(),
          },
        });
        expect(accepted.response?.[2]).toBeUndefined();
        const { key } = requirePayload(accepted) as { key: string };
        expect(key).not.toBe(SOURCE_SESSION_KEY);
        const entry = loadSessionEntry({ agentId: "main", sessionKey: key });
        expect(entry).toMatchObject({ spawnedCwd: cwd, parentSessionKey: SOURCE_SESSION_KEY });
        expect(entry).not.toHaveProperty("pendingWorktree");
        expect(entry).not.toHaveProperty("worktree");
        expect(mocks.handleChatSend).toHaveBeenCalledTimes(1);
        const dispatch = mocks.handleChatSend.mock.calls[0];
        if (!dispatch) {
          throw new Error("expected the follow-up task to reach agent dispatch");
        }
        expect(dispatch[0]).toMatchObject({
          params: { sessionKey: key, message: expect.stringContaining(prompt) },
        });
        const message = dispatch[0].params.message as string;
        expect(message).toContain("ask the user before creating or switching to it");
        expect(message.endsWith(`\n\n${prompt}`)).toBe(true);
        if (scenario === "unavailable Git metadata") {
          expect(await fs.readFile(gitMarker, "utf8")).toBe(brokenGit);
        } else {
          await expect(fs.stat(gitMarker)).rejects.toMatchObject({ code: "ENOENT" });
        }
      });
    },
  );
});
