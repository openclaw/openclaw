import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import {
  createReplyOperation,
  type ReplyBackendQueueMessageOptions,
} from "../../auto-reply/reply/reply-run-registry.js";
import { getRuntimeConfig } from "../../config/config.js";
import {
  listSessionPendingInputs,
  loadSessionEntry,
  patchSessionEntryCore,
} from "../../config/sessions/session-accessor.js";
import { registerSupervisedTaskAdmissionOwner } from "../../tasks/supervised-task.admission-owner.js";
import { heartbeatTaskSupervisor, listSupervisedTasks } from "../../tasks/supervised-task.store.js";
import { createDirectChatContext } from "../server-chat.agent-events.test-helpers.js";
import {
  dispatchInboundMessageMock,
  installGatewayTestHooks,
  testState,
  writeSessionStore,
} from "../test-helpers.js";
import { handleDirectExternalChatSend } from "./chat-send-external-entry.js";
import { handleChatSend } from "./chat-send-handler.js";
import type { GatewayClient, RespondFn } from "./types.js";

const classifier = vi.hoisted(() => vi.fn());
vi.mock("../../agents/isolated-completion.js", () => ({ runIsolatedCompletion: classifier }));
vi.mock("../../agents/harness/policy.js", () => ({
  resolveAgentHarnessPolicy: () => ({ runtime: "codex", runtimeSource: "provider" }),
}));
installGatewayTestHooks();
const dirs = useAutoCleanupTempDirTracker(afterEach);
const cleanups: Array<() => void> = [];
beforeEach(() => {
  classifier
    .mockReset()
    .mockResolvedValue({ text: '{"kind":"task"}', owner: { kind: "harness", id: "codex" } });
});
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) {
    cleanup();
  }
});

async function fixture(active = true) {
  const dir = dirs.make("supervised-chat-");
  const workspace = path.join(dir, "workspace");
  await fs.mkdir(workspace);
  const policyFile = path.join(dir, "policy.json");
  await fs.writeFile(
    policyFile,
    JSON.stringify({
      version: 1,
      scope: "Repair a fixture",
      goal: {
        objective: "Repair fixture",
        success: [{ id: "correct", description: "Reviewed artifact" }],
        partial: [],
      },
      workflow: {
        version: 1,
        workspace,
        profiles: [],
        acceptance: [{ kind: "operator", criterionId: "correct" }],
      },
      maxAttempts: 4,
      attemptTimeoutMs: 10_000,
      episodeTimeoutMs: 60_000,
    }),
    { mode: 0o600 },
  );
  testState.agentsConfig = {
    entries: { main: { taskSupervision: { enabled: true, policyFile } } },
  };
  testState.agentConfig = { model: { primary: "openai/supervision-fixture-model" } };
  const storePath = path.join(dir, "sessions.json");
  testState.sessionStorePath = storePath;
  const scope = {
    agentId: "main",
    sessionKey: "agent:main:main",
    sessionId: "chat-source",
    storePath,
  };
  await writeSessionStore({
    entries: {
      main: {
        sessionId: scope.sessionId,
        updatedAt: Date.now(),
        status: active ? "running" : "done",
      },
    },
  });
  const queueMessage = vi.fn(async (_text: string, options?: ReplyBackendQueueMessageOptions) => {
    await options?.userTurnTranscriptRecorder?.persistApproved();
  });
  if (active) {
    const operation = createReplyOperation({ ...scope, resetTriggered: false });
    operation.setPhase("running");
    // The simulated backend has matching prepared tool authority. This test
    // exercises real ingress ordering/custody, not the fingerprint algorithm.
    operation.bindToolAuthoritySnapshot({
      fingerprint: () => "fixture-authority",
      project: () => "fixture-authority",
    });
    operation.bindToolAuthorityRoute({ provider: "openai", model: "supervision-fixture-model" });
    operation.attachBackend({
      kind: "embedded",
      runId: "existing-model-run",
      cancel: vi.fn(),
      messageInjection: { isAvailable: () => true, queueMessage },
    });
    cleanups.push(() => operation.complete());
  }
  cleanups.push(
    registerSupervisedTaskAdmissionOwner(async () => {
      heartbeatTaskSupervisor("test-supervisor", Date.now(), 10_000);
      return "test-supervisor";
    }),
  );
  dispatchInboundMessageMock.mockResolvedValue({});
  const context = createDirectChatContext({ getRuntimeConfig, chatQueuedTurns: new Map() });
  const client: GatewayClient = {
    connId: "supervised-browser",
    connect: {
      minProtocol: 1,
      maxProtocol: 1,
      role: "operator",
      scopes: ["operator.read", "operator.write", "operator.admin"],
      client: { id: "openclaw-control-ui", version: "test", platform: "web", mode: "webchat" },
    },
  };
  const params = {
    sessionKey: scope.sessionKey,
    sessionId: scope.sessionId,
    message: "Repair the fixture",
    idempotencyKey: "supervised-chat-input",
    queueMode: "steer" as const,
  };
  const send = async (respond = vi.fn<RespondFn>(), external = true) => {
    await (external ? handleDirectExternalChatSend : handleChatSend)({
      params,
      req: { type: "req", id: "request", method: "chat.send", params },
      context,
      client,
      respond,
      isWebchatConnect: () => true,
    });
  };
  return { scope, queueMessage, send, context, client, params };
}

it("admits before ACK or active backend injection and replays the same task after a lost response", async () => {
  const f = await fixture();
  const release = createDeferred();
  classifier.mockImplementation(async () => {
    await release.promise;
    return { text: '{"kind":"task"}', owner: { kind: "harness", id: "codex" } };
  });
  const respond = vi.fn<RespondFn>();
  const sent = f.send(respond);
  try {
    await vi.waitFor(() =>
      expect(classifier, JSON.stringify(respond.mock.calls)).toHaveBeenCalledOnce(),
    );
    expect(respond).not.toHaveBeenCalled();
    expect(f.queueMessage).not.toHaveBeenCalled();
    expect(dispatchInboundMessageMock).not.toHaveBeenCalled();
  } finally {
    release.resolve();
    await sent;
  }
  expect(respond).toHaveBeenCalledWith(
    true,
    expect.objectContaining({
      status: "ok",
      supervisedTask: expect.objectContaining({ episode: 1 }),
    }),
    undefined,
    expect.anything(),
  );
  const tasks = listSupervisedTasks();
  expect(tasks).toHaveLength(1);
  expect(tasks[0]).toMatchObject({ phase: "ready", attempts: 0 });
  expect(listSessionPendingInputs(f.scope).total).toBe(0);
  f.context.dedupe.clear();
  await f.send();
  expect(classifier).toHaveBeenCalledOnce();
  expect(listSupervisedTasks()).toEqual(tasks);
  expect(f.queueMessage).not.toHaveBeenCalled();
  expect(dispatchInboundMessageMock).not.toHaveBeenCalled();
});

it("does not admit after the exact source session rotates during classification", async () => {
  const f = await fixture(false);
  classifier.mockImplementation(async () => {
    await patchSessionEntryCore(f.scope, () => ({ sessionId: "replacement-session" }));
    return { text: '{"kind":"task"}', owner: { kind: "harness", id: "codex" } };
  });
  const respond = vi.fn<RespondFn>();
  await f.send(respond);
  expect(classifier).toHaveBeenCalledOnce();
  expect(listSupervisedTasks()).toHaveLength(0);
  expect(dispatchInboundMessageMock).not.toHaveBeenCalled();
  expect(respond.mock.calls.some(([ok]) => !ok)).toBe(true);
  expect(loadSessionEntry(f.scope)?.sessionId).toBe("replacement-session");
});

it("keeps internal re-entry out of automatic admission", async () => {
  const f = await fixture();
  await f.send(vi.fn<RespondFn>(), false);
  expect(classifier).not.toHaveBeenCalled();
  expect(listSupervisedTasks()).toHaveLength(0);
  expect(f.queueMessage).toHaveBeenCalledOnce();
});

it("preserves ordinary active-run injection when the classifier selects conversation", async () => {
  const f = await fixture();
  classifier.mockResolvedValue({
    text: '{"kind":"ordinary"}',
    owner: { kind: "harness", id: "codex" },
  });
  await f.send();
  expect(classifier).toHaveBeenCalledOnce();
  expect(listSupervisedTasks()).toHaveLength(0);
  expect(f.queueMessage).toHaveBeenCalledOnce();
});
