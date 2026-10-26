import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  clearRuntimeConfigSnapshot,
  setRuntimeConfigSnapshot,
} from "../../config/runtime-snapshot.js";
import { upsertSessionEntryCore } from "../../config/sessions/session-accessor.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { closeOpenClawAgentDatabasesForTest } from "../../state/openclaw-agent-db.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { initializeRepository } from "../server.sessions.create.projects.test-support.js";
import { abandonTaskSuggestionAcceptance } from "../task-suggestion-registry.js";
import { sessionCreateHandlers } from "./sessions-create.js";
import { sessionDispatchHandlers } from "./sessions-dispatch.js";
import {
  call,
  configuredCloudContext,
  createSourceSuggestion,
  dismissPendingTaskSuggestions,
  SOURCE_SESSION_KEY,
} from "./task-suggestions.test-support.js";
import type { RespondFn } from "./types.js";

const { handleChatSend } = vi.hoisted(() => ({ handleChatSend: vi.fn() }));
// mock-isolation: exercise suggestion recovery without starting a real agent turn.
vi.mock("./chat-send-handler.js", () => ({ handleChatSend }));

beforeEach(async () => {
  await dismissPendingTaskSuggestions();
  handleChatSend.mockReset().mockImplementation(async ({ respond }: { respond: RespondFn }) => {
    respond(true, { runId: "suggested-task-run", status: "started" }, undefined);
  });
});

afterEach(async () => {
  await dismissPendingTaskSuggestions();
  vi.restoreAllMocks();
  closeOpenClawAgentDatabasesForTest();
  clearRuntimeConfigSnapshot();
});

it.each(["worktree", "local", "cloud", "session"] as const)(
  "keeps %s suggestions retryable when their owner is temporarily unavailable",
  (mode) =>
    withOpenClawTestState({ scenario: "minimal" }, async ({ root }) => {
      setRuntimeConfigSnapshot({});
      await upsertSessionEntryCore(
        { agentId: "main", sessionKey: SOURCE_SESSION_KEY },
        { sessionId: "source-session", updatedAt: 1 },
      );
      const taskId = await createSourceSuggestion();
      const config: OpenClawConfig = {
        agents: { entries: { other: {} } },
        cloudWorkers: { profiles: { primary: { provider: "test" } } },
      };
      const context = { ...configuredCloudContext(), getRuntimeConfig: () => config };
      const acceptParams = {
        taskId,
        mode,
        ...(mode === "cloud" ? { cloudProfileId: "primary" } : {}),
        // The source snapshot need not include Git metadata; own the worktree prerequisite.
        ...(mode === "worktree" ? { cwd: await initializeRepository(root, "project") } : {}),
      };
      const createSession = vi
        .spyOn(sessionCreateHandlers, "sessions.create")
        .mockImplementation(async ({ params, respond }) => {
          respond(true, { key: (params as { key: string }).key, runStarted: true }, undefined);
        });
      const dispatchSession = vi
        .spyOn(sessionDispatchHandlers, "sessions.dispatch")
        .mockImplementation(async ({ respond }) => respond(true, { ok: true }, undefined));
      const calls = () =>
        [createSession, dispatchSession, handleChatSend].map((fn) => fn.mock.calls.length);
      try {
        const rejected = await call("taskSuggestions.accept", acceptParams, vi.fn(), { context });
        expect(rejected.response?.[2]).toMatchObject({
          code: "INVALID_REQUEST",
          message: 'Unknown agent id "main"',
        });
        expect(calls()).toEqual([0, 0, 0]);
        const listed = await call("taskSuggestions.list", {});
        expect(listed.response?.[1]).toMatchObject({ suggestions: [{ id: taskId }] });

        config.agents = { entries: { main: {} } };
        const accepted = await call("taskSuggestions.accept", acceptParams, vi.fn(), { context });
        expect(accepted.response?.[0], JSON.stringify(accepted.response)).toBe(true);
        config.agents = { entries: { other: {} } };
        const replay = await call("taskSuggestions.accept", acceptParams, vi.fn(), { context });
        expect(replay.response).toEqual(accepted.response);
        expect(calls()).toEqual([
          mode === "session" ? 0 : 1,
          mode === "cloud" ? 1 : 0,
          mode === "session" || mode === "cloud" ? 1 : 0,
        ]);
      } finally {
        abandonTaskSuggestionAcceptance(taskId);
      }
    }),
);
