import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { setRuntimeConfigSnapshot } from "../../config/runtime-snapshot.js";
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

const { handleChatSend } = vi.hoisted(() => ({ handleChatSend: vi.fn() }));
// mock-isolation: exercise suggestion admission without starting a real agent turn.
vi.mock("./chat-send-handler.js", () => ({ handleChatSend }));

beforeEach(async () => {
  await dismissPendingTaskSuggestions();
  handleChatSend.mockReset().mockImplementation(async ({ respond }: { respond: RespondFn }) => {
    respond(true, { runId: "suggested-task-run", status: "started" }, undefined);
  });
});

afterEach(async () => {
  await dismissPendingTaskSuggestions();
  closeOpenClawAgentDatabasesForTest();
});

async function sourceSuggestion(cwd: string, prompt: string, operator = false) {
  const config = { agents: { defaults: { workspace: cwd } } };
  setRuntimeConfigSnapshot(config);
  await upsertSessionEntryCore(
    { agentId: "main", sessionKey: SOURCE_SESSION_KEY },
    { sessionId: operator ? "source-recovery" : "follow-up-source", updatedAt: 1 },
  );
  const options = {
    config,
    ...(operator ? { client: operatorClient() } : {}),
    context: {
      loadGatewayModelCatalog: async () => [],
      getSessionEventSubscriberConnIds: () => new Set<string>(),
    },
  };
  const request = (method: Parameters<typeof call>[0], params: Record<string, unknown>) =>
    call(method, params, vi.fn(), options);
  const created = await request("taskSuggestions.create", {
    title: "Investigate service",
    prompt,
    tldr: "Service stopped.",
    cwd,
    sessionKey: SOURCE_SESSION_KEY,
  });
  return { request, taskId: (requirePayload(created) as { taskId: string }).taskId };
}

it("keeps an unborn-repository suggestion retryable and starts it once from the corrected repository", () =>
  withOpenClawTestState({ scenario: "minimal" }, async ({ root, workspaceDir }) => {
    const cwd = await fs.realpath(workspaceDir);
    await promisify(execFile)("git", ["init", "-b", "main", cwd]);
    const repository = await initializeRepository(root, "project");
    const prompt = "Investigate the service shutdown using retained evidence.";
    const { taskId, request } = await sourceSuggestion(cwd, prompt, true);
    const rejected = await request("taskSuggestions.accept", { taskId, mode: "worktree" });
    expect(rejected.response).toMatchObject([
      false,
      undefined,
      { code: "INVALID_REQUEST", details: { code: "TASK_WORKTREE_SOURCE_REQUIRED", cwd } },
    ]);
    expect(handleChatSend).not.toHaveBeenCalled();
    expect(requirePayload(await request("taskSuggestions.list", {}))).toMatchObject({
      suggestions: [expect.objectContaining({ id: taskId, cwd, prompt })],
    });

    const correction = { taskId, mode: "worktree", cwd: repository };
    const accepted = await request("taskSuggestions.accept", correction);
    expect(accepted.response?.[2]).toBeUndefined();
    const { key } = requirePayload(accepted) as { key: string };
    expect(loadSessionEntry({ agentId: "main", sessionKey: key })).toMatchObject({
      pendingWorktree: { workspace: repository },
      parentSessionKey: SOURCE_SESSION_KEY,
    });
    expect(handleChatSend).toHaveBeenCalledTimes(1);
    expect(handleChatSend.mock.calls[0]?.[0]).toMatchObject({
      params: { sessionKey: key, message: prompt },
    });
    expect(requirePayload(await request("taskSuggestions.accept", correction))).toEqual({
      taskId,
      key,
    });
    expect(handleChatSend).toHaveBeenCalledTimes(1);
    await expect(
      promisify(execFile)("git", ["-C", cwd, "rev-parse", "--verify", "HEAD"]),
    ).rejects.toBeDefined();
  }));

it.each(["plain folder", "unavailable Git metadata"])("starts a local task: %s", (scenario) =>
  withOpenClawTestState({ scenario: "minimal" }, async ({ workspaceDir }) => {
    const cwd = await fs.realpath(workspaceDir);
    const gitMarker = path.join(cwd, ".git");
    const brokenGit = "gitdir: /missing/follow-up-repository\n";
    if (scenario === "unavailable Git metadata") {
      await fs.writeFile(gitMarker, brokenGit);
    }
    const prompt = "Investigate the restarting local service without changing storage.";
    const { taskId, request } = await sourceSuggestion(cwd, prompt);
    const accepted = await request("taskSuggestions.accept", { taskId, mode: "local" });
    expect(accepted.response?.[2]).toBeUndefined();
    const { key } = requirePayload(accepted) as { key: string };
    expect(key).not.toBe(SOURCE_SESSION_KEY);
    const entry = loadSessionEntry({ agentId: "main", sessionKey: key });
    expect(entry).toMatchObject({ spawnedCwd: cwd, parentSessionKey: SOURCE_SESSION_KEY });
    expect(entry).not.toHaveProperty("pendingWorktree");
    expect(entry).not.toHaveProperty("worktree");
    expect(handleChatSend).toHaveBeenCalledTimes(1);
    const { sessionKey, message } = expectDefined(handleChatSend.mock.calls[0], "chat send")[0]
      .params;
    expect(sessionKey).toBe(key);
    expect(message).toContain("ask the user before creating or switching to it");
    expect(message.endsWith(`\n\n${prompt}`)).toBe(true);
    if (scenario === "unavailable Git metadata") {
      expect(await fs.readFile(gitMarker, "utf8")).toBe(brokenGit);
    } else {
      await expect(fs.stat(gitMarker)).rejects.toMatchObject({ code: "ENOENT" });
    }
  }),
);
