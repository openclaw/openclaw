// Preserve module setup before modules that consume it.
// oxfmt-ignore
import { useChatAbortRegistryFixture } from "./chat.abort-registry.test-support.js";
import path from "node:path";
import { expect, it, vi } from "vitest";
import { awaitGateBeforeSettlement, createDeferred } from "../../../test/helpers/promise.js";
import * as embeddedRuns from "../../agents/embedded-agent-runner/runs.js";
import { createEmbeddedRunHandle } from "../../agents/embedded-agent-runner/runs.test-support.js";
import {
  createControlRunFixture,
  enqueueControlRun,
} from "../../agents/subagents/registry/subagent-control.fixtures.test-support.js";
import { getSubagentRunByChildSessionKey } from "../../agents/subagents/registry/subagent-registry.test-helpers.js";
import * as swarm from "../../agents/subagents/swarm/swarm-scheduler.js";
import { getRuntimeConfig, setRuntimeConfigSnapshot } from "../../config/config.js";
import * as sessions from "../../config/sessions/session-accessor.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { bindSessionRowProjection } from "../session-row-projection-access.js";
import { createSessionRowProjection } from "../session-row-projection.js";
import { handleChatSend } from "./chat-send-handler.js";
import {
  createActiveRun,
  createChatAbortContext,
  invokeChatAbortHandler,
} from "./chat.abort.test-helpers.js";

const fixture = useChatAbortRegistryFixture();
const controlRuns = createControlRunFixture(() => fixture.stateDir);

function registerChild(
  runId: string,
  scope: Parameters<typeof sessions.loadSessionEntryReadOnly>[0] & { sessionKey: string },
  requesterSessionKey: string,
  queued = true,
) {
  const agentId = scope.agentId ?? "main";
  return controlRuns.register(runId, scope.storePath, {
    childSessionKey: scope.sessionKey,
    childAgentId: agentId,
    sessionEntry: sessions.loadSessionEntryReadOnly(scope),
    requesterSessionKey,
    requesterAgentId: agentId,
    requesterDisplayKey: requesterSessionKey,
    requesterTurnRunId: "parent",
    collect: true,
    queued,
  });
}

function sendStop(
  context: ReturnType<typeof createChatAbortContext>,
  sessionKey: string,
  scopes: string[],
  extra: Record<string, unknown> & { agentId?: string } = {},
) {
  return invokeChatAbortHandler({
    handler: (options) =>
      handleChatSend({
        ...options,
        params: { sessionKey, message: "/stop", idempotencyKey: "typed-stop", ...extra },
      }),
    context,
    request: { sessionKey, ...(extra.agentId ? { agentId: extra.agentId } : {}) },
    client: { connId: "owner", connect: { scopes } },
  });
}

function expectRejected(
  respond: Awaited<ReturnType<typeof sendStop>>,
  error: Record<string, unknown> = { details: { reason: "active-leaf-changed" } },
) {
  expect(respond).toHaveBeenCalledWith(false, undefined, expect.objectContaining(error));
}

function releaseChild(runId: string) {
  swarm.releaseSwarmRun(`${runId}-capacity`);
  swarm.releaseSwarmRun(runId);
}

function createGuardedStopFixture() {
  const storePath = path.join(fixture.stateDir, "shared.sqlite");
  const cfg: OpenClawConfig = {
    agents: {
      ownership: "explicit",
      entries: { research: {}, ops: {} },
      defaults: { workspace: fixture.stateDir, sessionStore: { agentId: "ops" } },
    },
    session: { store: storePath },
    browser: { enabled: false },
  };
  setRuntimeConfigSnapshot(cfg, cfg);
  const seed = (sessionKey: string, agentId: string, sessionId: string) => {
    const scope = { agentId, storePath, sessionKey, sessionId };
    sessions.replaceSessionEntrySync(scope, {
      sessionId,
      lifecycleRevision: "original",
      updatedAt: Date.now(),
    });
    return scope;
  };
  const other = seed("agent:research:guarded-other", "research", "research-other");
  const parent = seed("agent:ops:guarded-parent", "ops", "ops-parent");
  const context = createChatAbortContext({
    getRuntimeConfig: () => cfg,
    getSessionEventSubscriberConnIds: () => new Set(),
  });
  const otherRun = createActiveRun(other.sessionKey, other);
  context.chatAbortControllers.set("other-owner", otherRun);
  const send = (sessionKey: string, extra: Record<string, unknown> = {}) =>
    sendStop(context, sessionKey, ["operator.admin"], { agentId: "ops", ...extra });
  const child = async (runId: string, requesterSessionKey = parent.sessionKey) => {
    const scope = seed(`agent:ops:subagent:${runId}`, "ops", `${runId}-session`);
    const groupId = `guarded-stop-${runId}`;
    const reservation = { groupId, runId, maxConcurrent: 1, activeRunIds: [`${runId}-capacity`] };
    expect(swarm.reserveSwarmRun(reservation)).toBe(true);
    await registerChild(runId, scope, requesterSessionKey);
    const start = vi.fn(async () => {});
    swarm.activateSwarmRun({ groupId, runId, start, onStartFailure: () => true });
    return { ...scope, runId, start, [Symbol.dispose]: () => releaseChild(runId) };
  };
  return { cfg, context, parent, other, otherRun, seed, send, child };
}

function appendStopCanary(
  scope: Parameters<typeof sessions.appendTranscriptMessageSync>[0],
  eventId: string,
  content: string,
) {
  const entry = { eventId, message: { role: "user", content }, parentId: null };
  expect(sessions.appendTranscriptMessageSync(scope, entry).ok).toBe(true);
}

it.each([
  ["stale leaf", false, { expectedLeafEntryId: "stale" }],
  ["copied leaf", false, { expectedLeafEntryId: "current-leaf", sessionId: "previous-session" }],
  [
    "steer compatibility",
    true,
    { expectedLeafEntryId: "stale", sessionId: "old", queueMode: "steer" },
  ],
] as const)("Stop validates %s and preserves the other owner", async (name, accepted, extra) => {
  const test = createGuardedStopFixture();
  const selected = test.parent;
  appendStopCanary(selected, "current-leaf", "selected conversation");
  await sessions.waitForSessionTranscriptProjection(selected);
  const before = await sessions.loadTranscriptEvents(selected);
  const active = createActiveRun(selected.sessionKey, selected);
  const queued = createActiveRun(selected.sessionKey, selected);
  test.context.chatAbortControllers.set("parent", active);
  test.context.chatQueuedTurns.set("queued", queued);
  const respond = await test.send(selected.sessionKey, extra);

  if (accepted) {
    expect(respond).toHaveBeenCalledWith(true, {
      ok: true,
      aborted: true,
      runIds: ["queued", "parent"],
    });
  } else {
    expectRejected(respond);
  }
  expect(active.controller.signal.aborted, name).toBe(accepted);
  expect(queued.controller.signal.aborted, name).toBe(accepted);
  expect(test.context.chatQueuedTurns.has("queued")).toBe(!accepted);
  expect(test.otherRun.controller.signal.aborted).toBe(false);
  expect(sessions.loadSessionEntryReadOnly(test.other)?.sessionId).toBe(test.other.sessionId);
  expect(await sessions.loadTranscriptEvents(selected)).toEqual(before);
});

it("typed Stop cannot acquire a replacement collector after yielding", async () => {
  const test = createGuardedStopFixture();
  using collector = await test.child("collector");
  using descendant = await test.child("collector-descendant", collector.sessionKey);
  const old = createActiveRun(collector.sessionKey, collector);
  test.context.chatAbortControllers.set("old-collector", old);
  test.context.chatRunState.getOrCreate("old-collector").buffer = "old collector partial";
  await using cleanup = new AsyncDisposableStack();
  const projection = await createSessionRowProjection({ cfg: test.cfg });
  cleanup.defer(() => projection.dispose());
  await projection.ensureMaterialized();
  bindSessionRowProjection(test.context, () => projection);
  const entered = createDeferred();
  const resume = createDeferred();
  const materialize = projection.ensureMaterialized.bind(projection);
  const readiness = vi.spyOn(projection, "ensureMaterialized").mockImplementationOnce(async () => {
    entered.resolve();
    await resume.promise;
    await materialize();
  });
  cleanup.defer(readiness.mockRestore);
  const pending = test.send(collector.sessionKey, {
    expectedLeafEntryId: null,
    sessionId: collector.sessionId,
  });
  cleanup.defer(async () => {
    resume.resolve();
    await pending;
  });
  await awaitGateBeforeSettlement(
    entered.promise,
    pending,
    "Stop completed before collector projection readiness",
  );
  const replacement = { ...collector, sessionId: "replacement-collector" };
  sessions.replaceSessionEntrySync(replacement, {
    sessionId: replacement.sessionId,
    lifecycleRevision: "successor",
    updatedAt: Date.now(),
  });
  appendStopCanary(replacement, "replacement-leaf", "replacement collector canary");
  const successor = createActiveRun(collector.sessionKey, replacement);
  const queued = createActiveRun(collector.sessionKey, replacement);
  test.context.chatAbortControllers.set("successor-collector", successor);
  test.context.chatQueuedTurns.set("successor-queued", queued);
  resume.resolve();
  const respond = await pending;
  expectRejected(respond);
  for (const run of [old, successor, queued, test.otherRun]) {
    expect(run.controller.signal.aborted).toBe(false);
  }
  expect(test.context.chatQueuedTurns.get("successor-queued")).toBe(queued);
  for (const child of [collector, descendant]) {
    expect((await getSubagentRunByChildSessionKey(child.sessionKey))?.execution.status).toBe(
      "queued",
    );
    expect(child.start).not.toHaveBeenCalled();
  }
  const events = JSON.stringify(await sessions.loadTranscriptEvents(replacement));
  expect(events).toContain("replacement collector canary");
  expect(events).not.toContain("old collector partial");
  swarm.releaseSwarmRun("collector-capacity");
  swarm.releaseSwarmRun("collector-descendant-capacity");
  await vi.waitFor(() => {
    expect(collector.start).toHaveBeenCalledOnce();
    expect(descendant.start).toHaveBeenCalledOnce();
  });
});

it("typed Stop preserves ownership errors when the requested leaf is still active", async () => {
  const test = createGuardedStopFixture();
  using collector = await test.child("collector");
  const before = await getSubagentRunByChildSessionKey(collector.sessionKey);
  sessions.replaceSessionEntrySync(collector, {
    sessionId: collector.sessionId,
    lifecycleRevision: "successor",
    updatedAt: Date.now(),
  });
  const sessionBefore = sessions.loadSessionEntryReadOnly(collector);
  const respond = await test.send(collector.sessionKey, {
    expectedLeafEntryId: null,
    sessionId: collector.sessionId,
  });
  expectRejected(respond, {
    code: "UNAVAILABLE",
    message: expect.stringContaining("Subagent original session incarnation"),
  });
  expect(await getSubagentRunByChildSessionKey(collector.sessionKey)).toEqual(before);
  expect(sessions.loadSessionEntryReadOnly(collector)).toEqual(sessionBefore);
  expect(collector.start).not.toHaveBeenCalled();
});

it.each(["owned", "orphan", "foreign", "protected"])("Stop ownership: %s", async (kind) => {
  const sessionKey = "agent:main:main";
  const runningKey = "agent:main:subagent:running";
  const queuedKey = "agent:main:subagent:queued";
  const storePath = await controlRuns.writeSession("parent", undefined, { sessionKey });
  const parentScope = { storePath, sessionKey, sessionId: "parent-session", agentId: "main" };
  for (const [runId, childSessionKey] of [
    ["running", runningKey],
    ["queued", queuedKey],
  ] as const) {
    await controlRuns.writeSession(runId);
    await registerChild(
      runId,
      { storePath, sessionKey: childSessionKey },
      sessionKey,
      runId === "queued",
    );
  }
  const dispatch = vi.fn(async () => {});
  enqueueControlRun("typed-stop", "queued", ["capacity"], dispatch);
  const runningAbort = vi.fn();
  const handle = createEmbeddedRunHandle({ runId: "running", abort: runningAbort });
  embeddedRuns.setActiveEmbeddedRun("running-session", handle, runningKey);
  const parent = createActiveRun(sessionKey, {
    ...parentScope,
    owner: { connId: kind === "foreign" ? "foreign" : "owner" },
    controlUiVisible: kind === "protected" ? false : undefined,
  });
  parent.controller.signal.addEventListener("abort", () => swarm.releaseSwarmRun("capacity"));
  const context = createChatAbortContext({ getRuntimeConfig });
  if (kind !== "orphan") {
    context.chatAbortControllers.set("parent", parent);
    context.chatRunState.getOrCreate("parent").buffer = "partial parent reply";
  }
  const canCascade = kind === "owned" || kind === "orphan";
  try {
    const respond = await sendStop(context, kind === "owned" ? "main" : sessionKey, [
      "operator.read",
      "operator.write",
    ]);
    expect(respond.mock.calls.at(-1)?.[0]).toBe(kind !== "foreign");
    expect(parent.controller.signal.aborted).toBe(kind === "owned");
    expect(runningAbort).toHaveBeenCalledTimes(canCascade ? 1 : 0);
    for (const key of [runningKey, queuedKey]) {
      expect((await getSubagentRunByChildSessionKey(key))?.execution.status).toBe(
        canCascade ? "terminal" : key === runningKey ? "running" : "queued",
      );
    }
    swarm.releaseSwarmRun("capacity");
    if (canCascade) {
      expect(dispatch).not.toHaveBeenCalled();
      expect(respond).toHaveBeenCalledWith(true, {
        ok: true,
        aborted: true,
        runIds: kind === "owned" ? ["parent"] : [],
      });
    } else {
      await vi.waitFor(() => expect(dispatch).toHaveBeenCalledOnce());
    }
    const events = await sessions.loadTranscriptEvents(parentScope);
    if (kind === "owned") {
      expect(events.map((event) => event.message)).toContainEqual(
        expect.objectContaining({
          content: [{ type: "text", text: "partial parent reply" }],
          openclawAbort: expect.objectContaining({
            aborted: true,
            origin: "stop-command",
            runId: "parent",
          }),
        }),
      );
    }
  } finally {
    embeddedRuns.clearActiveEmbeddedRun("running-session", handle, runningKey);
    swarm.releaseSwarmRun("capacity");
    swarm.releaseSwarmRun("queued");
  }
});
