import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { MsgContext } from "../auto-reply/templating.js";
import { DURABLE_INTAKE_ENVELOPE_SCHEMA } from "../durable/intake-envelope.js";
import { DURABLE_CHAT_SEND_OPERATION_KIND } from "../durable/runtime-ids.js";
import { openDurableRuntimeStore } from "../durable/store-factory.js";
import {
  appendContextRefsToMsgContext,
  normalizeGatewayContextRefs,
  recordDurableChatSendFrontdoorIntake,
  recordDurableChatSendTerminal,
  renderContextRefsAsUntrustedPromptBlock,
} from "./context-refs.js";

describe("gateway context refs", () => {
  it("normalizes bounded context references", () => {
    const result = normalizeGatewayContextRefs([
      {
        type: "work_unit",
        id: " workboard:default:card-1 ",
        label: " Card 1 ",
        source: "workboard",
        metadata: { status: "todo" },
      },
    ]);

    expect(result).toEqual({
      ok: true,
      refs: [
        {
          type: "work_unit",
          id: "workboard:default:card-1",
          label: "Card 1",
          source: "workboard",
          metadata: { status: "todo" },
        },
      ],
    });
    expect(normalizeGatewayContextRefs([{ type: "bad type", id: "wu-1" }])).toEqual({
      ok: false,
      error: "contextRefs[0].type contains unsupported characters",
    });
  });

  it("attaches context references as untrusted runtime context", () => {
    const refs = [{ type: "work_unit", id: "workboard:default:card-1" }];
    const ctx: MsgContext = { Body: "hello" };

    appendContextRefsToMsgContext(ctx, refs);
    const block = renderContextRefsAsUntrustedPromptBlock(refs);

    expect(ctx.UntrustedStructuredContext).toEqual([
      {
        label: "Runtime context references",
        source: "gateway.contextRefs",
        type: "openclaw.context_refs.v1",
        payload: { contextRefs: refs },
      },
    ]);
    expect(block).toContain("Runtime context references (untrusted)");
    expect(block).toContain('"type": "work_unit"');
  });

  it("records durable chat.send frontdoor intake when durable runtime is enabled", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-context-refs-"));
    const env = {
      ...process.env,
      OPENCLAW_STATE_DIR: dir,
      OPENCLAW_DURABLE_RUNTIME: "1",
    };

    try {
      recordDurableChatSendFrontdoorIntake({
        runId: "run-1",
        sessionKey: "agent:main:main",
        agentId: "main",
        message: "hello",
        attachmentCount: 0,
        contextRefs: [{ type: "work_unit", id: "workboard:default:card-1" }],
        env,
        now: 123,
      });

      const store = openDurableRuntimeStore({ env });
      try {
        const runs = store.listRuns({ limit: 10 });
        expect(runs).toHaveLength(1);
        expect(runs[0]).toMatchObject({
          operationKind: DURABLE_CHAT_SEND_OPERATION_KIND,
          idempotencyKey: "run-1",
          sourceType: "chat.send",
          sourceRef: "agent:main:main",
          workUnitId: "workboard:default:card-1",
          reportRouteId: "agent:main:main",
          metadata: {
            workUnitId: "workboard:default:card-1",
            reportRouteId: "agent:main:main",
            contextRefs: [{ type: "work_unit", id: "workboard:default:card-1" }],
            intakeEnvelope: expect.objectContaining({
              schema: DURABLE_INTAKE_ENVELOPE_SCHEMA,
              sourceType: "chat.send",
              sessionKey: "agent:main:main",
              attachmentCount: 0,
              replay: expect.objectContaining({
                inputAvailability: "preview_only",
                canReplay: false,
              }),
            }),
          },
        });
        expect(store.listRefs(runs[0]!.runtimeRunId)).toEqual([
          expect.objectContaining({
            refKind: "input",
            metadata: expect.objectContaining({
              intakeEnvelope: expect.objectContaining({
                schema: DURABLE_INTAKE_ENVELOPE_SCHEMA,
              }),
            }),
          }),
        ]);
        expect(store.listSteps(runs[0]!.runtimeRunId)).toEqual([
          expect.objectContaining({
            stepId: "intake",
            stepType: "checkpoint",
            metadata: expect.objectContaining({
              intakeEnvelope: expect.objectContaining({
                schema: DURABLE_INTAKE_ENVELOPE_SCHEMA,
              }),
            }),
          }),
        ]);
        expect(store.getTimeline(runs[0]!.runtimeRunId)).toEqual([
          expect.objectContaining({ eventType: "chat.send.received", stepId: "intake" }),
        ]);
      } finally {
        store.close();
      }
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("marks durable chat.send frontdoor runs terminal", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-context-refs-terminal-"));
    const env = {
      ...process.env,
      OPENCLAW_STATE_DIR: dir,
      OPENCLAW_DURABLE_RUNTIME: "1",
    };

    try {
      recordDurableChatSendFrontdoorIntake({
        runId: "run-terminal",
        sessionKey: "agent:main:main",
        agentId: "main",
        message: "hello",
        attachmentCount: 0,
        contextRefs: [],
        env,
        now: 123,
      });
      recordDurableChatSendTerminal({
        runId: "run-terminal",
        sessionKey: "agent:main:main",
        agentId: "main",
        status: "succeeded",
        summary: "dispatch completed",
        env,
        now: 456,
      });

      const store = openDurableRuntimeStore({ env });
      try {
        const [run] = store.listRuns({ limit: 10 });
        expect(run).toMatchObject({
          operationKind: DURABLE_CHAT_SEND_OPERATION_KIND,
          idempotencyKey: "run-terminal",
          reportRouteId: "agent:main:main",
          status: "succeeded",
          recoveryState: "terminal",
          completedAt: 456,
        });
        expect(store.listSteps(run!.runtimeRunId)).toEqual([
          expect.objectContaining({
            stepId: "intake",
            status: "succeeded",
            recoveryState: "terminal",
          }),
        ]);
        expect(store.getTimeline(run!.runtimeRunId).map((event) => event.eventType)).toEqual([
          "chat.send.received",
          "chat.send.succeeded",
        ]);
      } finally {
        store.close();
      }
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
