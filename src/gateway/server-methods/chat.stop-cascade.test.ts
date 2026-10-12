/** Typed Stop exercises the real chat.send pipeline and collector cancellation owners. */
// Preserve module setup before modules that consume it.
// oxfmt-ignore
import { useChatAbortRegistryFixture } from "./chat.abort-registry.test-support.js";
import path from "node:path";
import { expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import {
  clearActiveEmbeddedRun,
  setActiveEmbeddedRun,
} from "../../agents/embedded-agent-runner/runs.js";
import { createEmbeddedRunHandle } from "../../agents/embedded-agent-runner/runs.test-support.js";
import {
  getLatestLiveSubagentRunByChildSessionKey,
  isSubagentRunQueued,
} from "../../agents/subagents/registry/subagent-registry-read.js";
import { registerSubagentRun } from "../../agents/subagents/registry/subagent-registry.js";
import { writeSubagentSessionEntry } from "../../agents/subagents/registry/subagent-registry.persistence.test-support.js";
import { getSubagentRunByChildSessionKey } from "../../agents/subagents/registry/subagent-registry.test-helpers.js";
import {
  activateSwarmRun,
  enqueueSwarmRun,
  releaseSwarmRun,
  reserveSwarmRun,
} from "../../agents/subagents/swarm/swarm-scheduler.js";
import { getRuntimeConfig, setRuntimeConfigSnapshot } from "../../config/config.js";
import {
  appendTranscriptMessageSync,
  loadSessionEntryReadOnly,
  loadTranscriptEvents,
  replaceSessionEntrySync,
  waitForSessionTranscriptProjection,
} from "../../config/sessions/session-accessor.js";
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
    replaceSessionEntrySync(scope, {
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
    invokeChatAbortHandler({
      handler: (options) =>
        handleChatSend({
          ...options,
          params: {
            sessionKey,
            agentId: "ops",
            message: "/stop",
            idempotencyKey: "guarded-stop",
            ...extra,
          },
        }),
      context,
      request: { sessionKey, agentId: "ops" },
      client: { connId: "owner", connect: { scopes: ["operator.admin"] } },
    });
  const child = async (runId: string, requesterSessionKey = parent.sessionKey) => {
    const scope = seed(`agent:ops:subagent:${runId}`, "ops", `${runId}-session`);
    const groupId = `guarded-stop-${runId}`;
    expect(
      reserveSwarmRun({
        groupId,
        runId,
        maxConcurrent: 1,
        activeRunIds: [`${runId}-capacity`],
      }),
    ).toBe(true);
    await registerSubagentRun({
      runId,
      childSessionKey: scope.sessionKey,
      requesterSessionKey,
      requesterAgentId: "ops",
      requesterDisplayKey: requesterSessionKey,
      requesterTurnRunId: "parent",
      task: runId,
      cleanup: "keep",
      collect: true,
      queued: true,
      expectsCompletionMessage: false,
    });
    const start = vi.fn(async () => {});
    activateSwarmRun({
      groupId,
      runId,
      start,
      onStartFailure: () => true,
    });
    return { ...scope, runId, start };
  };
  return { cfg, context, parent, other, otherRun, seed, send, child };
}

function appendStopCanary(
  scope: Parameters<typeof appendTranscriptMessageSync>[0],
  eventId: string,
  content: string,
) {
  expect(
    appendTranscriptMessageSync(scope, {
      eventId,
      message: { role: "user", content },
      parentId: null,
    }).ok,
  ).toBe(true);
}

it.each([
  {
    name: "stale leaf",
    key: "agent:ops:guarded-parent",
    expectedLeafEntryId: "stale",
    accepted: false,
  },
  {
    name: "copied leaf from another session",
    key: "agent:ops:guarded-parent",
    expectedLeafEntryId: "current-leaf",
    sessionId: "previous-session",
    accepted: false,
  },
  {
    name: "steer compatibility",
    key: "agent:ops:guarded-parent",
    expectedLeafEntryId: "stale",
    sessionId: "old",
    queueMode: "steer",
    accepted: true,
  },
])(
  "typed Stop honors $name without touching the other owner",
  async ({ name, key, accepted, ...extra }) => {
    const test = createGuardedStopFixture();
    const selected = test.parent;
    appendStopCanary(selected, "current-leaf", "selected conversation");
    await waitForSessionTranscriptProjection(selected);
    const before = await loadTranscriptEvents(selected);
    const active = createActiveRun(selected.sessionKey, selected);
    const queued = createActiveRun(selected.sessionKey, selected);
    test.context.chatAbortControllers.set("parent", active);
    test.context.chatQueuedTurns.set("queued", queued);
    const respond = await test.send(key, extra);

    if (accepted) {
      expect(respond).toHaveBeenCalledWith(true, {
        ok: true,
        aborted: true,
        runIds: ["queued", "parent"],
      });
    } else {
      expect(respond).toHaveBeenCalledWith(
        false,
        undefined,
        expect.objectContaining({ details: { reason: "active-leaf-changed" } }),
      );
    }
    expect(active.controller.signal.aborted, name).toBe(accepted);
    expect(queued.controller.signal.aborted, name).toBe(accepted);
    expect(test.context.chatQueuedTurns.has("queued")).toBe(!accepted);
    expect(test.otherRun.controller.signal.aborted).toBe(false);
    expect(loadSessionEntryReadOnly(test.other)?.sessionId).toBe(test.other.sessionId);
    expect(await loadTranscriptEvents(selected)).toEqual(before);
  },
);

it("typed Stop cannot acquire a replacement collector after projection readiness yields", async () => {
  const test = createGuardedStopFixture();
  const collector = await test.child("collector");
  expect(isSubagentRunQueued(getLatestLiveSubagentRunByChildSessionKey(collector.sessionKey))).toBe(
    true,
  );
  const descendant = await test.child("collector-descendant", collector.sessionKey);
  const old = createActiveRun(collector.sessionKey, collector);
  test.context.chatAbortControllers.set("old-collector", old);
  test.context.chatRunState.getOrCreate("old-collector").buffer = "old collector partial";
  const projection = await createSessionRowProjection({ cfg: test.cfg });
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
  const pending = test.send(collector.sessionKey, {
    expectedLeafEntryId: null,
    sessionId: collector.sessionId,
  });
  try {
    await Promise.race([
      entered.promise,
      pending.then((respond) => {
        throw new Error(
          `Stop did not reach collector projection readiness: ${JSON.stringify(respond.mock.calls)}`,
        );
      }),
    ]);
    const replacement = { ...collector, sessionId: "replacement-collector" };
    replaceSessionEntrySync(replacement, {
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
    expect(respond).toHaveBeenCalledWith(
      false,
      undefined,
      expect.objectContaining({ details: { reason: "active-leaf-changed" } }),
    );
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
    const events = await loadTranscriptEvents(replacement);
    expect(JSON.stringify(events)).toContain("replacement collector canary");
    expect(JSON.stringify(events)).not.toContain("old collector partial");
    releaseSwarmRun("collector-capacity");
    releaseSwarmRun("collector-descendant-capacity");
    await vi.waitFor(() => {
      expect(collector.start).toHaveBeenCalledOnce();
      expect(descendant.start).toHaveBeenCalledOnce();
    });
  } finally {
    resume.resolve();
    try {
      await pending;
    } finally {
      readiness.mockRestore();
      projection.dispose();
      for (const runId of ["collector", "collector-descendant"]) {
        releaseSwarmRun(`${runId}-capacity`);
        releaseSwarmRun(runId);
      }
    }
  }
});

it.each([
  { kind: "owned", requestSessionKey: "main" },
  { kind: "orphan", requestSessionKey: "agent:main:main" },
  { kind: "foreign", requestSessionKey: "agent:main:main" },
  { kind: "protected", requestSessionKey: "agent:main:main" },
])(
  "typed Stop respects full-session collector ownership: $kind via $requestSessionKey",
  async ({ kind, requestSessionKey }) => {
    const sessionKey = "agent:main:main";
    const runningKey = "agent:main:subagent:running";
    const queuedKey = "agent:main:subagent:queued";
    const storePath = await writeSubagentSessionEntry({
      stateDir: fixture.stateDir,
      agentId: "main",
      sessionKey,
      defaultSessionId: "parent-session",
    });
    for (const [runId, childSessionKey] of [
      ["running", runningKey],
      ["queued", queuedKey],
    ] as const) {
      await writeSubagentSessionEntry({
        stateDir: fixture.stateDir,
        agentId: "main",
        sessionKey: childSessionKey,
        defaultSessionId: `${runId}-session`,
      });
      await registerSubagentRun({
        runId,
        childSessionKey,
        requesterSessionKey: sessionKey,
        requesterAgentId: "main",
        requesterDisplayKey: sessionKey,
        requesterTurnRunId: "parent",
        task: runId,
        cleanup: "keep",
        collect: true,
        queued: runId === "queued",
        expectsCompletionMessage: false,
      });
    }
    const dispatch = vi.fn(async () => {});
    enqueueSwarmRun({
      groupId: "typed-stop",
      runId: "queued",
      maxConcurrent: 1,
      activeRunIds: ["capacity"],
      start: dispatch,
      onStartFailure: () => true,
    });
    const runningAbort = vi.fn();
    const handle = createEmbeddedRunHandle({ runId: "running", abort: runningAbort });
    setActiveEmbeddedRun("running-session", handle, runningKey);
    const parent = createActiveRun(sessionKey, {
      sessionId: "parent-session",
      agentId: "main",
      owner: { connId: kind === "foreign" ? "foreign" : "owner" },
      controlUiVisible: kind === "protected" ? false : undefined,
    });
    parent.controller.signal.addEventListener("abort", () => releaseSwarmRun("capacity"));
    const context = createChatAbortContext({ getRuntimeConfig });
    if (kind !== "orphan") {
      context.chatAbortControllers.set("parent", parent);
      context.chatRunState.getOrCreate("parent").buffer = "partial parent reply";
    }
    const canCascade = kind === "owned" || kind === "orphan";
    try {
      const respond = await invokeChatAbortHandler({
        handler: (options) =>
          handleChatSend({
            ...options,
            params: {
              sessionKey: requestSessionKey,
              message: "/stop",
              idempotencyKey: "typed-stop",
            },
          }),
        context,
        request: { sessionKey: requestSessionKey },
        client: { connId: "owner", connect: { scopes: ["operator.read", "operator.write"] } },
      });
      expect(respond.mock.calls.at(-1)?.[0]).toBe(kind !== "foreign");
      expect(parent.controller.signal.aborted).toBe(kind === "owned");
      expect(runningAbort).toHaveBeenCalledTimes(canCascade ? 1 : 0);
      for (const key of [runningKey, queuedKey]) {
        expect((await getSubagentRunByChildSessionKey(key))?.execution.status).toBe(
          canCascade ? "terminal" : key === runningKey ? "running" : "queued",
        );
      }
      releaseSwarmRun("capacity");
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
      const events = await loadTranscriptEvents({
        storePath,
        sessionKey,
        sessionId: "parent-session",
        agentId: "main",
      });
      if (kind === "owned") {
        expect(events).toContainEqual(
          expect.objectContaining({
            message: expect.objectContaining({
              content: [{ type: "text", text: "partial parent reply" }],
              openclawAbort: expect.objectContaining({
                aborted: true,
                origin: "stop-command",
                runId: "parent",
              }),
            }),
          }),
        );
      }
    } finally {
      clearActiveEmbeddedRun("running-session", handle, runningKey);
      releaseSwarmRun("capacity");
      releaseSwarmRun("queued");
    }
  },
);
