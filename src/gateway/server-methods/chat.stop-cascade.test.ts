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

function registerChild(
  runId: string,
  scope: Parameters<typeof loadSessionEntryReadOnly>[0] & { sessionKey: string },
  requesterSessionKey: string,
  agentId: string,
  queued = true,
) {
  return registerSubagentRun({
    runId,
    childSessionKey: scope.sessionKey,
    childAgentId: agentId,
    sessionEntry: loadSessionEntryReadOnly(scope),
    requesterSessionKey,
    requesterAgentId: agentId,
    requesterDisplayKey: requesterSessionKey,
    requesterTurnRunId: "parent",
    task: runId,
    cleanup: "keep",
    collect: true,
    queued,
    expectsCompletionMessage: false,
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

function expectChangedLeaf(respond: Awaited<ReturnType<typeof sendStop>>) {
  expect(respond).toHaveBeenCalledWith(
    false,
    undefined,
    expect.objectContaining({ details: { reason: "active-leaf-changed" } }),
  );
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
    sendStop(context, sessionKey, ["operator.admin"], { agentId: "ops", ...extra });
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
    await registerChild(runId, scope, requesterSessionKey, "ops");
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
  ["stale leaf", false, { expectedLeafEntryId: "stale" }],
  ["copied leaf", false, { expectedLeafEntryId: "current-leaf", sessionId: "previous-session" }],
  [
    "steer compatibility",
    true,
    { expectedLeafEntryId: "stale", sessionId: "old", queueMode: "steer" },
  ],
] as const)(
  "typed Stop honors %s without touching the other owner",
  async (name, accepted, extra) => {
    const test = createGuardedStopFixture();
    const selected = test.parent;
    appendStopCanary(selected, "current-leaf", "selected conversation");
    await waitForSessionTranscriptProjection(selected);
    const before = await loadTranscriptEvents(selected);
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
      expectChangedLeaf(respond);
    }
    expect(active.controller.signal.aborted, name).toBe(accepted);
    expect(queued.controller.signal.aborted, name).toBe(accepted);
    expect(test.context.chatQueuedTurns.has("queued")).toBe(!accepted);
    expect(test.otherRun.controller.signal.aborted).toBe(false);
    expect(loadSessionEntryReadOnly(test.other)?.sessionId).toBe(test.other.sessionId);
    expect(await loadTranscriptEvents(selected)).toEqual(before);
  },
);

it("typed Stop cannot acquire a replacement collector after yielding", async () => {
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
      pending.then(() => {
        throw new Error("Stop completed before collector projection readiness");
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
    expectChangedLeaf(respond);
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

it("typed Stop preserves ownership errors when the requested leaf is still active", async () => {
  const test = createGuardedStopFixture();
  const collector = await test.child("collector");
  const before = await getSubagentRunByChildSessionKey(collector.sessionKey);
  replaceSessionEntrySync(collector, {
    sessionId: collector.sessionId,
    lifecycleRevision: "successor",
    updatedAt: Date.now(),
  });
  const sessionBefore = loadSessionEntryReadOnly(collector);
  try {
    const respond = await test.send(collector.sessionKey, {
      expectedLeafEntryId: null,
      sessionId: collector.sessionId,
    });
    expect(respond).toHaveBeenCalledWith(
      false,
      undefined,
      expect.objectContaining({
        code: "UNAVAILABLE",
        message: expect.stringContaining("Subagent original session incarnation"),
      }),
    );
    expect(await getSubagentRunByChildSessionKey(collector.sessionKey)).toEqual(before);
    expect(loadSessionEntryReadOnly(collector)).toEqual(sessionBefore);
    expect(collector.start).not.toHaveBeenCalled();
  } finally {
    releaseSwarmRun("collector-capacity");
    releaseSwarmRun("collector");
  }
});

it.each(["owned", "orphan", "foreign", "protected"])(
  "typed Stop respects full-session collector ownership: %s",
  async (kind) => {
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
      await registerChild(
        runId,
        { storePath, sessionKey: childSessionKey },
        sessionKey,
        "main",
        runId === "queued",
      );
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
