import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from "vitest";
import { resetAgentEventsForTest } from "../infra/agent-events.js";
import { registerAgentRunContext } from "../infra/agent-run-registry.js";
import { parseAgentSessionKey } from "../routing/session-key.js";
import { createAgentEventTestHarness } from "./server-chat.agent-events.test-harness.js";
import { createSessionRowProjectionFixture } from "./session-row-projection.test-support.js";

function createLineageHarness(key: string, spawnedBy: string) {
  const agentId = expectDefined(parseAgentSessionKey(key)?.agentId, "lineage session owner");
  const projection = createSessionRowProjectionFixture({
    cfg: {},
    store: { [key]: { sessionId: "lineage", updatedAt: 1, spawnedBy } },
  });
  const h = createAgentEventTestHarness({
    resolveSessionKeyForRun: () => key,
    lifecycleErrorRetryGraceMs: 0,
    getSessionRowProjection: () => projection,
    loadGatewaySessionLifecycleSnapshotForEvent: () => projection.snapshot({ key, agentId }),
  });
  h.nodeHasSessionSubscribers.mockReturnValue(false);
  onTestFinished(async () => {
    await h.handler.dispose();
    h.chatRunState.clear();
    projection.dispose();
  });
  return { ...h, projection };
}

describe("spawnedBy enrichment in chat and agent broadcasts", () => {
  beforeEach(() => resetAgentEventsForTest({ preserveListeners: true }));
  afterEach(() => resetAgentEventsForTest({ preserveListeners: true }));

  it("reads current lineage only when output facts need sequence-gap enrichment", async () => {
    const key = "agent:main:dashboard:output-child";
    const runId = "run-output-lineage";
    const parent = "agent:main:task:parent";
    const nextParent = "agent:main:task:replacement";
    const h = createLineageHarness(key, parent);
    const readLineage = vi.spyOn(h.projection, "readPreparedSpawnedBy");
    h.register(runId, key, "client-output-lineage");
    h.toolEventRecipients.add(runId, "conn-output");
    h.sessionMessageSubscribers.subscribe("conn-output", key, { includeLiveToolOutput: true });

    for (const [seq, stream, phase, outputOnly, expectedParent] of [
      [1, "tool", "update", true, undefined],
      [2, "tool", "update", true, undefined],
      [3, "tool", "update", undefined, parent],
      [5, "tool", "update", true, nextParent],
      [6, "tool", "update", true, undefined],
      [7, "tool", "update", undefined, nextParent],
      [8, "tool", "start", true, nextParent],
      [9, "thinking", "update", true, nextParent],
    ] as const) {
      if (seq === 5) {
        h.projection.setEntry(key, { sessionId: "lineage", updatedAt: 2, spawnedBy: nextParent });
      }
      readLineage.mockClear();
      const data = {
        phase,
        name: "exec",
        toolCallId: "output-call",
        ...(outputOnly === undefined ? {} : { outputOnly }),
        partialResult: { content: [{ type: "text", text: `output ${seq}` }] },
      };
      await h.emit(runId, stream, data, { seq });
      expect(readLineage).toHaveBeenCalledTimes(expectedParent ? 1 : 0);
      const payload = expectDefined(
        [...h.agent(), ...h.targetedAgent()].find(
          ([, candidate]) => candidate.seq === seq && candidate.stream === stream,
        )?.[1],
        `delivered output ${seq}`,
      );
      expect(payload).toMatchObject({ sessionKey: key, seq, stream, data });
      expect(payload.spawnedBy).toBe(expectedParent);
    }
    expect(h.targetedAgent().map(([, payload]) => payload.seq)).toEqual([1, 2, 3, 5, 6, 7, 8]);
    const gap = h.agent().find(([, payload]) => payload.stream === "error")?.[1];
    expect(gap).toMatchObject({
      spawnedBy: nextParent,
      data: { reason: "seq gap", expected: 4, received: 5 },
    });
  });

  it.each([
    {
      name: "dashboard delta",
      key: "agent:main:dashboard:visible-child",
      parent: "agent:main:discord:direct:alice",
      state: "delta",
      events: [["assistant", { text: "visible child" }]],
    },
    {
      name: "subagent terminal error",
      key: "agent:coder:subagent:err",
      parent: "agent:conductor:task:parent-err",
      state: "error",
      events: [
        ["assistant", { text: "partial" }],
        ["lifecycle", { phase: "error", error: "provider failed" }],
      ],
    },
    {
      name: "subagent sequence gap",
      key: "agent:coder:subagent:gap",
      parent: "agent:conductor:task:parent-gap",
      state: "gap",
      events: [
        ["lifecycle", { phase: "start" }],
        ["assistant", { text: "skipped seq" }, { seq: 5 }],
      ],
    },
  ] as const)("includes spawnedBy in $name broadcasts", async ({ key, parent, state, events }) => {
    const h = createLineageHarness(key, parent);
    if (state === "gap") {
      registerAgentRunContext("run-lineage", { sessionKey: key });
    } else {
      h.register("run-lineage", key, "client-lineage");
    }
    await h.emitMany("run-lineage", events);
    const calls = state === "gap" ? h.agent() : h.chat();
    const call = expectDefined(
      calls.find(([, payload]) =>
        state === "gap"
          ? payload.stream === "error" && payload.data?.reason === "seq gap"
          : payload.state === state,
      ),
      "lineage broadcast",
    );
    expect(call[1]).toMatchObject({ sessionKey: key, spawnedBy: parent });
    if (state === "gap") {
      expect(call[1].data).toMatchObject({ reason: "seq gap", expected: 2, received: 5 });
    } else {
      expect(call[1]).toMatchObject({ state });
    }
  });
});
