import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  awaitGateBeforeSettlement,
  createDeferred,
  withinTest,
} from "../../../test/helpers/promise.js";
import {
  clearRuntimeConfigSnapshot,
  setRuntimeConfigSnapshot,
} from "../../config/runtime-snapshot.js";
import { upsertSessionEntryCore } from "../../config/sessions/session-accessor.js";
import { addSessionMember } from "../../config/sessions/session-sharing-store.native.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { closeOpenClawAgentDatabasesForTest } from "../../state/openclaw-agent-db.js";
import { prepareUserProfileCatalog } from "../../state/user-profile-list.js";
import { ensureProfileForEmail } from "../../state/user-profiles.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import {
  abandonTaskSuggestionAcceptance,
  beginTaskSuggestionAcceptance,
  completeTaskSuggestionAcceptance,
} from "../task-suggestion-registry.js";
import { sessionCreateHandlers } from "./sessions-create.js";
import { sessionDeleteHandlers } from "./sessions-delete.js";
import { sessionDispatchHandlers } from "./sessions-dispatch.js";
import {
  call,
  configuredCloudContext,
  createLocalTaskSuggestion,
  createSourceSuggestion,
  dismissPendingTaskSuggestions,
  GIT_CWD,
  operatorClient,
  requirePayload,
  SOURCE_SESSION_KEY,
} from "./task-suggestions.test-support.js";
import type { GatewayClient, GatewayRequestHandlerOptions, RespondFn } from "./types.js";

const mocks = vi.hoisted(() => ({ handleChatSend: vi.fn() }));
type TaskOperatorRole = "none" | "view" | "suggest" | "restricted";
const taskRoleConfig = (role: TaskOperatorRole): OpenClawConfig => ({
  gateway: {
    roles: {
      default: "guest",
      definitions: {
        guest: {
          sessions: { others: role === "restricted" ? "write" : role },
          agents: role === "restricted" ? ["allowed"] : "*",
          scopes: ["operator.read", "operator.write"],
        },
      },
    },
  },
});

function taskRoleClient(profileId: string, admin = false): GatewayClient {
  const client = operatorClient();
  client.connect.scopes = admin ? ["operator.admin"] : ["operator.read", "operator.write"];
  client.authenticatedUserId = profileId;
  client.authenticatedUserProfile = {
    profileId,
    displayName: null,
    hasAvatar: false,
    updatedAt: 1,
  };
  return client;
}

function createSuggestion(
  params: Record<string, unknown> = {},
  overrides?: Parameters<typeof call>[3],
) {
  return call(
    "taskSuggestions.create",
    {
      title: "Add coverage",
      prompt: "Add the missing regression test.",
      tldr: "The edge case is untested.",
      cwd: GIT_CWD,
      sessionKey: "agent:main:main",
      ...params,
    },
    vi.fn(),
    overrides,
  );
}

async function expectPending(taskId: string) {
  expect(await listedSuggestions()).toMatchObject([{ id: taskId }]);
}

async function listedSuggestions() {
  return (
    requirePayload(await call("taskSuggestions.list", {})) as { suggestions: { id: string }[] }
  ).suggestions;
}

async function createTask(params: Record<string, unknown> = {}) {
  return (requirePayload(await createSuggestion(params)) as { taskId: string }).taskId;
}

function accept(
  taskId: string,
  params: Record<string, unknown> = {},
  overrides?: Parameters<typeof call>[3],
) {
  return call("taskSuggestions.accept", { taskId, ...params }, vi.fn(), overrides);
}

function expectFailure(result: Awaited<ReturnType<typeof call>>, error: Record<string, unknown>) {
  expect(result.response?.[0]).toBe(false);
  expect(result.response?.[2]).toMatchObject(error);
}

type InspectParams = (params: GatewayRequestHandlerOptions["params"]) => void;
function mockCreatedSession(
  payload: Record<string, unknown> = { runStarted: true },
  inspect?: InspectParams,
) {
  const session = { key: "" };
  const spy = vi
    .spyOn(sessionCreateHandlers, "sessions.create")
    .mockImplementation(async ({ params, respond }) => {
      session.key = (params as { key: string }).key;
      inspect?.(params);
      respond(true, { key: session.key, ...payload }, undefined);
    });
  return Object.assign(session, { spy });
}

function mockDeletedSession(
  inspect?: InspectParams,
  payload: { deleted: boolean; ok?: boolean } = { deleted: true },
) {
  return vi
    .spyOn(sessionDeleteHandlers, "sessions.delete")
    .mockImplementation(async ({ params, respond }) => {
      inspect?.(params);
      respond(true, payload, undefined);
    });
}

async function createTaskRoleScenario(role: TaskOperatorRole, ownsSource = false) {
  setRuntimeConfigSnapshot(taskRoleConfig(role));
  const profile = ensureProfileForEmail(`task-${role}@example.test`);
  const owner = ownsSource ? profile : ensureProfileForEmail(`task-${role}-owner@example.test`);
  await upsertSessionEntryCore(
    { agentId: "main", sessionKey: SOURCE_SESSION_KEY },
    {
      sessionId: "shared-task-source",
      updatedAt: 1,
      visibility: "shared",
      createdActor: { type: "human", source: "profile", id: owner.id },
    },
  );
  const taskId = await createTask({ sessionKey: SOURCE_SESSION_KEY, agentId: "main" });
  const client = taskRoleClient(profile.id);
  const request = (method: "list" | "accept" | "dismiss", params: Record<string, unknown> = {}) =>
    call(`taskSuggestions.${method}`, params, vi.fn(), { client, config: taskRoleConfig(role) });
  return { owner, profile, taskId, request };
}

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
  vi.restoreAllMocks();
  closeOpenClawAgentDatabasesForTest();
  clearRuntimeConfigSnapshot();
});

it.each(["none", "suggest", "restricted"] as const)(
  "enforces %s role ownership, session access, and agent-creation boundaries",
  async (roleName) => {
    await withOpenClawTestState({ scenario: "minimal" }, async () => {
      const { owner, profile, taskId, request } = await createTaskRoleScenario(
        roleName,
        roleName === "restricted",
      );
      using _ = { [Symbol.dispose]: (await prepareUserProfileCatalog()).release };
      if (roleName === "none") {
        const ownSessionKey = "agent:main:dashboard:own-task-source";
        await upsertSessionEntryCore(
          { agentId: "main", sessionKey: ownSessionKey },
          {
            sessionId: "own-task-source",
            updatedAt: 1,
            createdActor: { type: "human", source: "profile", id: profile.id },
          },
        );
        const ownTaskId = await createTask({ sessionKey: ownSessionKey, agentId: "main" });
        expect((await request("list")).response?.[1]).toMatchObject({
          suggestions: [{ id: ownTaskId }],
        });
        expect((await request("list", { sessionKey: SOURCE_SESSION_KEY })).response?.[1]).toEqual({
          suggestions: [],
        });
        expect((await request("accept", { taskId, mode: "session" })).response?.[2]).toMatchObject({
          code: "INVALID_REQUEST",
          message: expect.stringContaining("was not found"),
        });
        const dismissed = await request("dismiss", { taskId });
        expect(dismissed.response?.[1]).toEqual({ taskId, dismissed: false });
        expect(dismissed.broadcast).not.toHaveBeenCalled();
        expect(mocks.handleChatSend).not.toHaveBeenCalled();
        const admin = await call("taskSuggestions.list", {}, vi.fn(), {
          client: taskRoleClient(profile.id, true),
          config: taskRoleConfig("none"),
        });
        expect(admin.response?.[1]).toMatchObject({
          suggestions: [{ id: ownTaskId }, { id: taskId }],
        });
        return;
      }
      if (roleName === "restricted") {
        const createSession = vi.spyOn(sessionCreateHandlers, "sessions.create");
        for (const mode of ["worktree", "local", "cloud", "session"] as const) {
          const accepted = await request("accept", { taskId, mode });
          expect(accepted.response?.[2], mode).toMatchObject({
            code: "FORBIDDEN",
            message: expect.stringContaining('agent "main"'),
          });
        }
        expect(createSession).not.toHaveBeenCalled();
        expect(mocks.handleChatSend).not.toHaveBeenCalled();
        expect((await request("list")).response?.[1]).toMatchObject({
          suggestions: [{ id: taskId }],
        });
        return;
      }
      const rejected = await request("accept", { taskId, mode: "session" });
      const dismissed = await request("dismiss", { taskId });
      expect(rejected.response?.[2]).toMatchObject({
        details: { code: "SESSION_PARTICIPATION_REQUIRED", visibility: "shared" },
      });
      expect(dismissed.response?.[1]).toEqual({ taskId, dismissed: false });
      expect(mocks.handleChatSend).not.toHaveBeenCalled();
      addSessionMember(
        { agentId: "main", sessionKey: SOURCE_SESSION_KEY },
        {
          identityId: profile.id,
          addedBy: owner.id,
          expectedSessionId: "shared-task-source",
        },
      );
      const accepted = await request("accept", { taskId, mode: "session" });
      const replay = await request("accept", { taskId, mode: "session" });
      expect([accepted.response?.[1], replay.response?.[1]]).toEqual([
        { taskId, key: SOURCE_SESSION_KEY },
        { taskId, key: SOURCE_SESSION_KEY },
      ]);
      expect(mocks.handleChatSend).toHaveBeenCalledTimes(1);
    });
  },
);

it("attributes a bare source session to the persisted fixed-store owner", async () => {
  const config = {
    session: { store: "/tmp/shared-sessions.sqlite", scope: "global" },
    agents: {
      ownership: "explicit",
      entries: { ops: {}, research: {} },
      defaults: { sessionStore: { agentId: "ops" } },
    },
  };
  const created = await createSuggestion({ sessionKey: "global" }, config);

  expect(created.response?.[0]).toBe(true);
  expect(created.response?.[1]).toMatchObject({ suggestion: { agentId: "ops" } });
  const listed = await call("taskSuggestions.list", { sessionKey: "global" }, vi.fn(), config);
  expect(listed.response?.[1]).toMatchObject({
    suggestions: [expect.objectContaining({ agentId: "ops", sessionKey: "global" })],
  });
});

it("evicts accepted-session replay before an unseen pending suggestion", async () => {
  const taskId = await createTask({
    title: "Remove stale adapter",
    prompt: "Delete src/example.ts and update its tests.",
    agentId: "main",
  });
  const session = mockCreatedSession({ runStarted: true }, (params) => {
    expect(params).toMatchObject({
      agentId: "main",
      parentSessionKey: "agent:main:main",
      label: "Remove stale adapter",
      task: "Delete src/example.ts and update its tests.",
      worktree: true,
      cwd: GIT_CWD,
    });
    expect(session.key).toMatch(/^agent:main:dashboard:/);
  });

  const first = await accept(taskId);
  for (let index = 0; index < 99; index += 1) {
    await createTask({ title: `Pending follow up ${index}` });
  }

  const oldestPending = (await listedSuggestions()).at(-1);
  expect(oldestPending).toBeDefined();
  const admitted = await createSuggestion({ title: "Latest follow up" });
  expect(admitted.response?.[0]).toBe(true);
  expect(admitted.broadcast).toHaveBeenCalledTimes(1);
  expect(admitted.broadcast).toHaveBeenCalledWith(
    "task.suggestion",
    expect.objectContaining({ action: "created" }),
    { dropIfSlow: true },
  );

  const retry = await accept(taskId);

  expect(first.response?.[1]).toEqual({ taskId, key: session.key });
  expectFailure(retry, { code: "INVALID_REQUEST" });
  expect(await listedSuggestions()).toContainEqual(
    expect.objectContaining({ id: oldestPending?.id }),
  );
  expect(session.spy).toHaveBeenCalledTimes(1);
  expect(first.broadcast).toHaveBeenCalledWith(
    "task.suggestion",
    { action: "resolved", taskId, resolution: "accepted" },
    { dropIfSlow: true, sessionKeys: ["agent:main:main"], agentId: "main" },
  );
});

it("coalesces concurrent acceptance requests", async ({ signal }) => {
  const taskId = await createTask();
  const { promise: gate, resolve: release } = createDeferred();
  const entered = createDeferred();
  const createSession = vi
    .spyOn(sessionCreateHandlers, "sessions.create")
    .mockImplementation(async ({ params, respond }) => {
      entered.resolve();
      await gate;
      respond(true, { key: (params as { key: string }).key, runStarted: true }, undefined);
    });

  const first = accept(taskId).then((result) => {
    expect(result.response?.[2]).toBeUndefined();
    requirePayload(result);
    return result;
  });
  let second: ReturnType<typeof call> | undefined;
  try {
    await withinTest(
      awaitGateBeforeSettlement(
        entered.promise,
        first,
        "acceptance settled before entering sessions.create",
      ),
      signal,
    );
    expect(createSession).toHaveBeenCalledTimes(1);
    second = accept(taskId);
    release();
    const [firstResult, secondResult] = await withinTest(Promise.all([first, second]), signal);

    expect(firstResult.response?.[1]).toEqual(secondResult.response?.[1]);
    expect(createSession).toHaveBeenCalledTimes(1);
  } finally {
    release();
    await Promise.allSettled([first, second]);
  }
});

it.each(["local", "failed seed"] as const)(
  "rolls back a %s session whose task does not start",
  async (mode) => {
    const local = mode === "local";
    const taskId = await (local ? createSourceSuggestion() : createLocalTaskSuggestion());
    const session = mockCreatedSession(
      {
        runStarted: false,
        ...(local ? {} : { runError: { message: "provider unavailable" } }),
      },
      (params) => {
        if (local) {
          expect(params).not.toHaveProperty("worktree");
          expect(params).toMatchObject({ cwd: GIT_CWD });
        }
      },
    );
    const deleteSession = mockDeletedSession(
      (params) => {
        if (!local) {
          expect(params).toEqual({
            key: session.key,
            agentId: "main",
            deleteTranscript: true,
            emitLifecycleHooks: false,
          });
        }
      },
      local ? { deleted: true } : { ok: true, deleted: true },
    );
    const accepted = await accept(taskId, local ? { mode: "local" } : {});
    expect(accepted.response?.[0]).toBe(false);
    expect(deleteSession).toHaveBeenCalledTimes(1);
    if (!local) {
      expect(accepted.response?.[2]).toMatchObject({ message: "provider unavailable" });
      expect(accepted.broadcast).toHaveBeenCalledWith(
        "task.suggestion",
        expect.objectContaining({
          action: "created",
          suggestion: expect.objectContaining({ id: taskId }),
        }),
        { dropIfSlow: true },
      );
    }
    await expectPending(taskId);
  },
);

it("creates, dispatches, then sends a cloud acceptance", async () => {
  const taskId = await createSourceSuggestion();
  const sequence: string[] = [];
  const session = mockCreatedSession({ runStarted: false }, (params) => {
    sequence.push("create");
    expect(params).toEqual({
      key: session.key,
      agentId: "main",
      parentSessionKey: SOURCE_SESSION_KEY,
      label: "Fix the source session",
      worktree: true,
      cwd: GIT_CWD,
    });
  });
  vi.spyOn(sessionDispatchHandlers, "sessions.dispatch").mockImplementation(
    async ({ params, respond }) => {
      sequence.push("dispatch");
      expect(params).toEqual({ key: session.key, agentId: "main", profileId: "primary" });
      respond(true, { ok: true, key: session.key }, undefined);
    },
  );
  mocks.handleChatSend.mockImplementationOnce(async ({ params, respond }) => {
    sequence.push("send");
    expect(params).toEqual({
      sessionKey: session.key,
      agentId: "main",
      message: "Apply the focused fix in this session.",
      queueMode: "steer",
      idempotencyKey: `task-suggestion:${taskId}`,
    });
    respond(true, { runId: "cloud-run", status: "started" }, undefined);
  });

  const accepted = await accept(
    taskId,
    { mode: "cloud", cloudProfileId: "primary" },
    { client: operatorClient(), context: configuredCloudContext() },
  );

  expect(accepted.response?.[1]).toEqual({ taskId, key: session.key });
  expect(sequence).toEqual(["create", "dispatch", "send"]);
});

it.each([
  ["primary", "no cloud worker profiles configured", configuredCloudContext({})],
  ["missing", "unknown cloud worker profile: missing", configuredCloudContext()],
  [undefined, "cloudProfileId is required for cloud mode", configuredCloudContext()],
] as const)(
  "rejects cloud profile %s before handler calls",
  async (cloudProfileId, message, context) => {
    const taskId = await createSourceSuggestion();
    const createSession = vi.spyOn(sessionCreateHandlers, "sessions.create");
    const dispatchSession = vi.spyOn(sessionDispatchHandlers, "sessions.dispatch");

    const accepted = await accept(
      taskId,
      { mode: "cloud", ...(cloudProfileId ? { cloudProfileId } : {}) },
      { context },
    );
    expectFailure(accepted, { code: "INVALID_REQUEST", message });
    expect(createSession).not.toHaveBeenCalled();
    expect(dispatchSession).not.toHaveBeenCalled();
    expect(mocks.handleChatSend).not.toHaveBeenCalled();
  },
);

it("fully rolls back a cloud draft when dispatch fails", async () => {
  const taskId = await createSourceSuggestion();
  const session = mockCreatedSession({});
  vi.spyOn(sessionDispatchHandlers, "sessions.dispatch").mockImplementation(async ({ respond }) => {
    respond(false, undefined, { code: "UNAVAILABLE", message: "dispatch unavailable" });
  });
  const deleteSession = mockDeletedSession((params) => {
    expect(params).toMatchObject({ key: session.key, agentId: "main" });
  });

  const accepted = await accept(
    taskId,
    { mode: "cloud", cloudProfileId: "primary" },
    { context: configuredCloudContext() },
  );

  expectFailure(accepted, { message: "dispatch unavailable" });
  expect(deleteSession).toHaveBeenCalledTimes(1);
  expect(mocks.handleChatSend).not.toHaveBeenCalled();
  await expectPending(taskId);
});

it("sends an idle session acceptance as a new turn and replays its source key", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async () => {
    setRuntimeConfigSnapshot({});
    await upsertSessionEntryCore(
      { agentId: "main", sessionKey: SOURCE_SESSION_KEY },
      { sessionId: "source-session", updatedAt: 1 },
    );
    const taskId = await createSourceSuggestion();
    const client = operatorClient();

    const accepted = await call("taskSuggestions.accept", { taskId, mode: "session" }, vi.fn(), {
      client,
      context: {},
    });
    const replay = await call("taskSuggestions.accept", { taskId, mode: "session" });

    expect(accepted.response?.[0]).toBe(true);
    expect(accepted.response?.[1]).toEqual({ taskId, key: SOURCE_SESSION_KEY });
    expect(replay.response?.[1]).toEqual({ taskId, key: SOURCE_SESSION_KEY });
    expect(mocks.handleChatSend).toHaveBeenCalledTimes(1);
    expect(mocks.handleChatSend).toHaveBeenCalledWith(
      expect.objectContaining({
        client,
        params: {
          sessionKey: SOURCE_SESSION_KEY,
          agentId: "main",
          sessionId: "source-session",
          message: "Apply the focused fix in this session.",
          queueMode: "steer",
          idempotencyKey: `task-suggestion:${taskId}`,
        },
      }),
    );
  });
});

it.each([false, true])(
  "restores a source suggestion after failure (source exists: %s)",
  async (exists) => {
    await withOpenClawTestState({ scenario: "minimal" }, async () => {
      if (exists) {
        setRuntimeConfigSnapshot({});
        await upsertSessionEntryCore(
          { agentId: "main", sessionKey: SOURCE_SESSION_KEY },
          { sessionId: "source-session", updatedAt: 1 },
        );
        mocks.handleChatSend.mockImplementationOnce(async ({ respond }: { respond: RespondFn }) => {
          respond(false, undefined, { code: "UNAVAILABLE", message: "delivery unavailable" });
        });
      }
      const taskId = await createSourceSuggestion();
      const deleteSession = vi.spyOn(sessionDeleteHandlers, "sessions.delete");
      const accepted = await accept(
        taskId,
        { mode: "session" },
        {
          client: operatorClient(),
          context: {},
        },
      );
      expectFailure(
        accepted,
        exists
          ? { message: "delivery unavailable" }
          : {
              code: "INVALID_REQUEST",
              message: "source session no longer exists; start it in a new session instead",
            },
      );
      expect(deleteSession).not.toHaveBeenCalled();
      await expectPending(taskId);
    });
  },
);

it("rejects an invalid acceptance mode before claiming the suggestion", async () => {
  const taskId = await createSourceSuggestion();
  const createSession = vi.spyOn(sessionCreateHandlers, "sessions.create");

  const accepted = await accept(taskId, { mode: "remote" });
  expectFailure(accepted, { code: "INVALID_REQUEST", message: expect.stringContaining("mode") });
  expect(createSession).not.toHaveBeenCalled();
  await expectPending(taskId);
});

it("expires a suggestion when rollback preserves the worktree", async () => {
  const taskId = await createLocalTaskSuggestion();
  vi.spyOn(sessionCreateHandlers, "sessions.create").mockRejectedValue(
    new Error("initial dispatch failed"),
  );
  vi.spyOn(sessionDeleteHandlers, "sessions.delete").mockImplementation(async ({ respond }) => {
    respond(
      true,
      {
        ok: true,
        deleted: true,
        worktreePreserved: {
          id: "preserved-worktree",
          path: "/preserved-worktree",
          branch: "openclaw/preserved-worktree",
          reason: "cleanup-failed",
        },
      },
      undefined,
    );
  });

  const accepted = await accept(taskId);
  expect(accepted.response?.[0]).toBe(false);
  expect(accepted.response?.[2]?.message).toContain("failed to roll back");
  expect(accepted.broadcast).toHaveBeenCalledWith(
    "task.suggestion",
    { action: "resolved", taskId, resolution: "expired" },
    { dropIfSlow: true, sessionKeys: ["agent:main:main"], agentId: "main" },
  );
  expect(await listedSuggestions()).toEqual([]);
});

it.each([
  [{ cwd: "relative/folder" }, {}, "task suggestion cwd must be absolute"],
  [
    { agentId: "work" },
    { agents: { entries: { main: {}, work: {} } } },
    'agent "work" does not match session key agent "main"',
  ],
] as const)("rejects invalid creation %j before broadcasting", async (params, config, message) => {
  const result = await createSuggestion(params, config);
  expectFailure(result, { code: "INVALID_REQUEST", message });
  expect(result.broadcast).not.toHaveBeenCalled();
});

it("keeps the complete list below the retained payload budget", async () => {
  const taskIds: string[] = [];
  for (let index = 0; index < 70; index += 1) {
    taskIds.push(
      await createTask({ title: `Follow up ${index}`, prompt: `${index}: ${"x".repeat(32_760)}` }),
    );
  }

  const suggestions = await listedSuggestions();
  expect(Buffer.byteLength(JSON.stringify(suggestions))).toBeLessThanOrEqual(2 * 1024 * 1024);
  expect(suggestions.length).toBeLessThan(70);
  expect(suggestions.some((suggestion) => suggestion.id === taskIds[0])).toBe(false);
});

it("rejects impossible byte admission without evicting accepted or pending suggestions", async () => {
  const acceptingTaskIds: string[] = [];
  const largePrompt = "🦀".repeat(16_000);

  try {
    for (let index = 0; index < 32; index += 1) {
      const taskId = await createTask({ title: `Running follow up ${index}`, prompt: largePrompt });
      expect(beginTaskSuggestionAcceptance(taskId).status).toBe("claimed");
      acceptingTaskIds.push(taskId);
    }

    const acceptedTaskId = await createTask({ title: "Preserve accepted task" });
    expect(beginTaskSuggestionAcceptance(acceptedTaskId).status).toBe("claimed");
    completeTaskSuggestionAcceptance(acceptedTaskId, "agent:main:dashboard:accepted");

    const pendingTaskId = await createTask({ title: "Keep this follow up" });
    const rejected = await createSuggestion({
      title: "One oversized follow up",
      prompt: largePrompt,
    });

    expectFailure(rejected, {
      code: "UNAVAILABLE",
      message: "task suggestion registry is busy",
      retryable: true,
    });
    expect(rejected.broadcast).not.toHaveBeenCalled();
    expect(beginTaskSuggestionAcceptance(acceptedTaskId)).toEqual({
      status: "accepted",
      sessionKey: "agent:main:dashboard:accepted",
    });
    expect(await listedSuggestions()).toEqual([expect.objectContaining({ id: pendingTaskId })]);
  } finally {
    for (const taskId of acceptingTaskIds) {
      expect(abandonTaskSuggestionAcceptance(taskId)).toBe(true);
    }
  }
});
