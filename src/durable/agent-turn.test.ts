import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { startDurableAgentTurnLifecycle } from "./agent-turn.js";
import { DURABLE_INTAKE_ENVELOPE_SCHEMA } from "./intake-envelope.js";
import { DURABLE_AGENT_TURN_OPERATION_KIND } from "./runtime-ids.js";
import { openDurableRuntimeStore } from "./store-factory.js";

describe("durable agent turn lifecycle", () => {
  it("persists a bounded intake envelope on the run, input ref, and initial step", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-durable-agent-turn-"));
    const env = {
      ...process.env,
      OPENCLAW_STATE_DIR: dir,
      OPENCLAW_DURABLE_RUNTIME: "1",
      OPENCLAW_DURABLE_INPUT_PREVIEW_CHARS: "8",
    };

    try {
      const lifecycle = startDurableAgentTurnLifecycle({
        runId: "agent-run-1",
        message: "summarize this work unit",
        agentId: "bo",
        sessionKey: "agent:bo:main",
        channel: "discord",
        transport: "gateway",
        contextRefs: [{ type: "work_unit", id: "wu-1" }],
        env,
      });
      lifecycle.close();

      const store = openDurableRuntimeStore({ env });
      try {
        const [run] = store.listRuns({ limit: 10 });
        expect(run).toMatchObject({
          operationKind: DURABLE_AGENT_TURN_OPERATION_KIND,
          idempotencyKey: "agent-run-1",
          metadata: {
            intakeEnvelope: expect.objectContaining({
              schema: DURABLE_INTAKE_ENVELOPE_SCHEMA,
              runId: "agent-run-1",
              sourceType: "agent.turn",
              sessionKey: "agent:bo:main",
              message: expect.objectContaining({
                preview: "summariz",
                previewTruncated: true,
              }),
              replay: expect.objectContaining({
                inputAvailability: "preview_only",
                canReplay: false,
              }),
            }),
          },
        });
        const refs = store.listRefs(run!.runtimeRunId);
        expect(refs).toEqual([
          expect.objectContaining({
            refKind: "input",
            metadata: expect.objectContaining({
              intakeEnvelope: expect.objectContaining({
                schema: DURABLE_INTAKE_ENVELOPE_SCHEMA,
              }),
            }),
          }),
        ]);
        expect(store.listSteps(run!.runtimeRunId)).toEqual([
          expect.objectContaining({
            stepId: "agent_invocation",
            inputRef: refs[0]!.refId,
            metadata: expect.objectContaining({
              intakeEnvelope: expect.objectContaining({
                schema: DURABLE_INTAKE_ENVELOPE_SCHEMA,
              }),
            }),
          }),
        ]);
      } finally {
        store.close();
      }
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("keeps yielded turns open while child work is still running", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-durable-agent-turn-"));
    const env = {
      ...process.env,
      OPENCLAW_STATE_DIR: dir,
      OPENCLAW_DURABLE_RUNTIME: "1",
    };

    try {
      const lifecycle = startDurableAgentTurnLifecycle({
        runId: "agent-run-yielded",
        message: "coordinate a child agent",
        agentId: "bo",
        sessionKey: "agent:bo:main",
        transport: "gateway",
        env,
      });
      lifecycle.markRunning();

      const setupStore = openDurableRuntimeStore({ env });
      try {
        const [parent] = setupStore.listRuns({ limit: 10 });
        const child = setupStore.createRun({
          operationKind: "openclaw.subagent.run",
          status: "running",
          recoveryState: "running",
          parentRuntimeRunId: parent!.runtimeRunId,
          parentStepId: "subagents",
        });
        setupStore.createStep({
          runtimeRunId: parent!.runtimeRunId,
          stepId: "subagents",
          stepType: "fan_in",
          status: "waiting",
          recoveryState: "waiting_child",
        });
        setupStore.createLink({
          parentRuntimeRunId: parent!.runtimeRunId,
          parentStepId: "subagents",
          childRuntimeRunId: child.runtimeRunId,
          linkType: "subagent",
          status: "running",
        });
      } finally {
        setupStore.close();
      }

      lifecycle.markTerminal({
        status: "succeeded",
        eventType: "agent.turn.succeeded",
        payload: {
          summary: "completed",
          yielded: true,
          livenessState: "paused",
          openclawProgressKind: "agent-yield-paused",
        },
      });
      lifecycle.close();

      const store = openDurableRuntimeStore({ env });
      try {
        const [run] = store.listRuns({ limit: 10 });
        expect(run).toMatchObject({
          status: "waiting_child",
          recoveryState: "waiting_child",
          metadata: expect.objectContaining({
            lastYield: expect.objectContaining({
              yielded: true,
              livenessState: "paused",
              openclawProgressKind: "agent-yield-paused",
            }),
          }),
        });
        expect(run?.completedAt).toBeUndefined();
        expect(store.listSteps(run!.runtimeRunId)).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              stepId: "agent_invocation",
              status: "waiting",
              recoveryState: "waiting_child",
            }),
          ]),
        );
        expect(store.getTimeline(run!.runtimeRunId)).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              eventType: "agent.turn.yielded",
              payload: expect.objectContaining({
                status: "waiting_child",
                recoveryState: "waiting_child",
              }),
            }),
          ]),
        );
      } finally {
        store.close();
      }
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("records yielded turns without child links as waiting for a signal", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-durable-agent-turn-"));
    const env = {
      ...process.env,
      OPENCLAW_STATE_DIR: dir,
      OPENCLAW_DURABLE_RUNTIME: "1",
    };

    try {
      const lifecycle = startDurableAgentTurnLifecycle({
        runId: "agent-run-waiting-signal",
        message: "pause until human follows up",
        agentId: "bo",
        sessionKey: "agent:bo:main",
        transport: "gateway",
        env,
      });
      lifecycle.markRunning();
      lifecycle.markTerminal({
        status: "succeeded",
        eventType: "agent.turn.succeeded",
        payload: {
          summary: "completed",
          yielded: true,
          livenessState: "paused",
        },
      });
      lifecycle.close();

      const store = openDurableRuntimeStore({ env });
      try {
        const [run] = store.listRuns({ limit: 10 });
        expect(run).toMatchObject({
          status: "waiting_signal",
          recoveryState: "waiting_signal",
        });
        expect(run?.completedAt).toBeUndefined();
      } finally {
        store.close();
      }
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
