import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { AgentEventPayload } from "../infra/agent-events.js";
import { createTestGatewayScheduler } from "../test-utils/gateway-scheduler-clock.js";
import { createAgentEventAuditRecorder } from "./agent-event-audit.js";
import type { AuditEventInput } from "./audit-event-types.js";
import type { AuditEventWriter } from "./audit-event-writer.js";
import { createAuditEventRecorder } from "./audit-recorder.js";
import { emitTrustedMessageAuditEvent } from "./message-audit-events.js";
import { onTrustedMessageAuditEventForTest as onTrustedMessageAuditEvent } from "./message-audit-events.test-support.js";

let inputs: AuditEventInput[];
let writer: AuditEventWriter;
let recorder: ReturnType<typeof createAgentEventAuditRecorder>;
beforeEach(() => {
  inputs = [];
  const capture = (...events: AuditEventInput[]) => {
    inputs.push(...events);
    return true;
  };
  writer = {
    ready: Promise.resolve(),
    record: capture,
    recordRun: capture,
    recordExecutionIdentity: () => true,
    recordExecutionDecision: () => true,
    recordExecutionDecisionWork: () => true,
    stop: async () => {},
  };
});
afterEach(() => recorder?.stop());

function agentRecorder(options: Partial<Parameters<typeof createAgentEventAuditRecorder>[0]> = {}) {
  recorder = createAgentEventAuditRecorder({ writer, getConfig: () => ({}), ...options });
}

function runEvent(runId: string, seq = 1, phase = "start"): AgentEventPayload {
  return {
    runId,
    seq,
    stream: "lifecycle",
    ts: 1,
    lifecycleGeneration: "buffer-gateway",
    agentId: "main",
    sessionKey: "agent:main:main",
    sessionId: "buffer-session",
    data: { phase },
  };
}

function emitMessage(conversationKind: "direct" | "group") {
  emitTrustedMessageAuditEvent({
    occurredAt: 1,
    kind: "message",
    action: "message.inbound.processed",
    status: "succeeded",
    actorType: "channel_sender",
    actorId: "sender-raw",
    direction: "inbound",
    channel: "telegram",
    conversationKind,
    outcome: "completed",
  });
}

describe("message audit recorder", () => {
  it.each([
    ["off", ["direct"], []],
    ["direct", ["group", "direct"], ["direct"]],
    ["all", ["group"], ["group"]],
  ] as const)("filters messages in %s mode", async (messages, conversations, accepted) => {
    const messageRecorder = createAuditEventRecorder({
      scheduler: createTestGatewayScheduler(),
      getConfig: () => ({ logging: { audit: { messages } } }),
      writer,
    });
    recorder = messageRecorder;
    const unsubscribe = onTrustedMessageAuditEvent(messageRecorder.recordMessage);
    try {
      conversations.forEach(emitMessage);
    } finally {
      unsubscribe();
    }
    await recorder.stop();
    expect(inputs).toEqual(
      accepted.map((conversationKind, index) =>
        expect.objectContaining({
          kind: "message",
          conversationKind,
          sourceId: expect.stringMatching(/^message:/u),
          sourceSequence: index + 1,
        }),
      ),
    );
  });
});

describe("buffered agent audit starts", () => {
  it("retains the original start when a rejected pair settles after capacity returns", async () => {
    let accepting = false;
    agentRecorder({
      writer: {
        ...writer,
        recordRun: (start, finish) => accepting && writer.recordRun(start, finish),
      },
    });
    recorder.record(runEvent("rejected"));
    recorder.record(runEvent("rejected", 2, "end"));
    expect(inputs).toEqual([]);
    accepting = true;
    recorder.record(runEvent("rejected", 3, "end"));
    recorder.record(runEvent("rejected", 4, "end"));
    await recorder.stop();
    expect(inputs.map(({ action, sourceSequence }) => [action, sourceSequence])).toEqual([
      ["agent.run.started", 1],
      ["agent.run.finished", 3],
    ]);
  });

  it("flushes the oldest bounded start without duplicating it on retry, then drains unmatched starts", async () => {
    agentRecorder({ terminalSettleMs: 60_000 });
    for (let index = 0; index < 1_025; index += 1) {
      recorder.record(runEvent(`run-${index}`));
    }
    expect(inputs.map(({ runId }) => runId)).toEqual(["run-0"]);
    recorder.record(runEvent("run-0", 2, "error"));
    recorder.record(runEvent("run-0", 3));
    recorder.record(runEvent("run-0", 4, "end"));
    await recorder.stop();
    expect(inputs).toHaveLength(1_026);
    expect(inputs.filter(({ action }) => action === "agent.run.started")).toHaveLength(1_025);
    expect(inputs.filter(({ runId }) => runId === "run-0").map(({ action }) => action)).toEqual([
      "agent.run.started",
      "agent.run.finished",
    ]);
  });

  it.each(["lifecycle", "tool"] as const)(
    "drains an accepted start when a %s event observes collection disabled",
    async (observer) => {
      let enabled = true;
      agentRecorder({
        getConfig: () => ({ logging: { audit: { enabled } } }),
      });
      recorder.record(runEvent("accepted"));
      expect(inputs).toEqual([]);
      enabled = false;
      if (observer === "lifecycle") {
        recorder.record(runEvent("accepted", 2, "end"));
      } else {
        recorder.recordTool({
          type: "tool.execution.started",
          seq: 2,
          ts: 2,
          runId: "accepted",
          agentId: "main",
          toolName: "exec",
          toolCallId: "call-1",
        });
      }
      expect(inputs.map(({ action, runId }) => [action, runId])).toEqual([
        ["agent.run.started", "accepted"],
      ]);
      await recorder.stop();
      expect(inputs).toHaveLength(1);
    },
  );
});
