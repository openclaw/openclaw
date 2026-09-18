import { expect, it, vi } from "vitest";
import { registerSubagentRun } from "../../agents/subagents/registry/subagent-registry.js";
import {
  settleSubagentRegistryPersistenceWork,
  writeSubagentSessionEntry,
} from "../../agents/subagents/registry/subagent-registry.persistence.test-support.js";
import { enqueueSwarmRun } from "../../agents/subagents/swarm/swarm-scheduler.js";
import { getRuntimeConfig } from "../../config/config.js";
import { createChatRunState } from "../server-chat-state.js";
import { abortQueuedCollectorSession } from "./chat-abort-runtime.js";
import { useChatAbortRegistryFixture } from "./chat.abort-registry.test-support.js";
import { createActiveRun, createChatAbortContext } from "./chat.abort.test-helpers.js";

const persistence = vi.hoisted(() => ({ failed: false }));

vi.mock("./chat-transcript-persistence.js", async () => {
  const original = await vi.importActual<typeof import("./chat-transcript-persistence.js")>(
    "./chat-transcript-persistence.js",
  );
  return {
    ...original,
    persistAbortedPartials: vi.fn(async () => persistence.failed),
  };
});

const fixture = useChatAbortRegistryFixture();

it("returns a transcript warning when a queued-collector Stop loses an active partial", async () => {
  const sessionKey = "agent:main:subagent:queued-child";
  const sessionId = "queued-child-session";
  await writeSubagentSessionEntry({
    stateDir: fixture.stateDir,
    agentId: "main",
    sessionKey,
    defaultSessionId: sessionId,
  });
  enqueueSwarmRun({
    groupId: "queued-persistence",
    runId: "queued-collector",
    start: vi.fn(async () => {}),
    activeRunIds: ["occupied-slot"],
    maxConcurrent: 1,
    onStartFailure: () => true,
  });
  registerSubagentRun({
    runId: "queued-collector",
    childSessionKey: sessionKey,
    requesterSessionKey: "agent:main:main",
    requesterAgentId: "main",
    requesterDisplayKey: "main",
    task: "queued collector",
    cleanup: "keep",
    collect: true,
    queued: true,
    expectsCompletionMessage: false,
  });
  await settleSubagentRegistryPersistenceWork();
  const runState = createChatRunState();
  Object.assign(runState.getOrCreate("active-run"), { buffer: "Unsaved partial" });
  const context = createChatAbortContext({
    getRuntimeConfig,
    getSessionEventSubscriberConnIds: () => new Set(),
    chatAbortControllers: new Map([
      ["active-run", createActiveRun(sessionKey, { sessionId, agentId: "main" })],
    ]),
    chatRunState: runState,
  });
  persistence.failed = true;

  const pending = abortQueuedCollectorSession({
    context: context as never,
    sessionKey,
    sessionId,
    agentId: "main",
    abortOrigin: "rpc",
    stopReason: "rpc",
    requester: { isAdmin: true },
  });
  expect(pending).toBeDefined();
  const result = await pending!;
  if (!result.ok) {
    throw new Error(result.error.message);
  }

  expect(result).toMatchObject({
    ok: true,
    value: {
      aborted: true,
      runIds: expect.arrayContaining(["queued-collector", "active-run"]),
      warning: expect.stringContaining("could not be saved to the transcript"),
    },
  });
});
