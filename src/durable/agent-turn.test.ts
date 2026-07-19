import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { requireNodeSqlite } from "../infra/node-sqlite.js";
import {
  classifyDurableAgentTurnTerminal,
  completeDurableAgentTurnLifecycle,
  resolveDurableAgentTurnResultState,
  startDurableAgentTurnLifecycle,
} from "./agent-turn.js";
import { resolveDurableRuntimeSqlitePath } from "./config.js";
import { DURABLE_INTAKE_ENVELOPE_SCHEMA } from "./intake-envelope.js";
import { DURABLE_AGENT_TURN_OPERATION_KIND } from "./runtime-ids.js";
import { openDurableRuntimeStore } from "./store-factory.js";

const observeConfig = { mode: "observe" } as const;
const authorityConfig = { mode: "authority" } as const;

describe("durable agent turn lifecycle", () => {
  it("is inert when durable runtime is off", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-durable-agent-off-"));
    try {
      const lifecycle = startDurableAgentTurnLifecycle({
        runId: "agent-off",
        message: "do not persist",
        sessionKey: "agent:main:main",
        transport: "gateway",
        config: { mode: "off" },
        env: { ...process.env, OPENCLAW_STATE_DIR: dir },
      });
      lifecycle.markRunning();
      lifecycle.close();
      expect(fs.existsSync(path.join(dir, "openclaw.sqlite"))).toBe(false);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it.each([
    {
      input: { aborted: false, livenessState: "working" },
      expected: { status: "succeeded", eventType: "agent.turn.succeeded" },
    },
    {
      input: { aborted: false, livenessState: "blocked" },
      expected: { status: "failed", eventType: "agent.turn.blocked" },
    },
    {
      input: { aborted: false, livenessState: "abandoned" },
      expected: { status: "failed", eventType: "agent.turn.abandoned" },
    },
    {
      input: { aborted: true, livenessState: "blocked" },
      expected: { status: "cancelled", eventType: "agent.turn.cancelled" },
    },
    {
      input: { aborted: false, failed: true, livenessState: "working" },
      expected: { status: "failed", eventType: "agent.turn.failed" },
    },
  ])("classifies terminal liveness as $expected.eventType", ({ input, expected }) => {
    expect(classifyDurableAgentTurnTerminal(input)).toEqual(expected);
  });

  it("resolves yield and failure evidence from model-run result metadata", () => {
    expect(
      resolveDurableAgentTurnResultState({
        result: {
          meta: { error: { message: "provider failed" }, stopReason: "error" },
          payloads: [
            {
              channelData: {
                yielded: true,
                livenessState: "paused",
                openclawProgressKind: "agent-yield-paused",
              },
            },
          ],
        },
      }),
    ).toEqual({
      aborted: false,
      failed: true,
      yielded: true,
      livenessState: "paused",
      openclawProgressKind: "agent-yield-paused",
      stopReason: "error",
    });
  });

  it("records generic model-run failures as failed instead of succeeded", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-durable-agent-turn-"));
    const env = {
      ...process.env,
      OPENCLAW_STATE_DIR: dir,
    };

    try {
      const lifecycle = startDurableAgentTurnLifecycle({
        runId: "agent-run-failed",
        message: "run a provider call",
        sessionKey: "agent:main:main",
        transport: "channel",
        config: observeConfig,
        env,
      });
      lifecycle.markRunning();
      completeDurableAgentTurnLifecycle({
        lifecycle,
        result: { meta: { error: { message: "provider failed" } } },
      });
      lifecycle.close();

      const store = openDurableRuntimeStore({ env });
      try {
        const run = store.getRunByIdempotencyKey(
          DURABLE_AGENT_TURN_OPERATION_KIND,
          "agent-run-failed",
        );
        expect(run).toMatchObject({ status: "failed", recoveryState: "terminal" });
        expect(store.getTimeline(run!.runtimeRunId)).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              eventType: "agent.turn.failed",
              payload: expect.objectContaining({ summary: "failed" }),
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

  it("records only the first settlement when completion paths race", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-durable-agent-turn-settle-"));
    const env = {
      ...process.env,
      OPENCLAW_STATE_DIR: dir,
    };

    try {
      const lifecycle = startDurableAgentTurnLifecycle({
        runId: "agent-run-settlement-race",
        message: "finish exactly once",
        sessionKey: "agent:main:main",
        transport: "gateway",
        config: observeConfig,
        env,
      });
      lifecycle.markRunning();
      completeDurableAgentTurnLifecycle({ lifecycle, result: { meta: {} } });
      completeDurableAgentTurnLifecycle({ lifecycle, error: new Error("late rejection") });
      lifecycle.close();

      const store = openDurableRuntimeStore({ env });
      try {
        const run = store.getRunByIdempotencyKey(
          DURABLE_AGENT_TURN_OPERATION_KIND,
          "agent-run-settlement-race",
        );
        expect(run).toMatchObject({ status: "succeeded", recoveryState: "terminal" });
        const terminalEvents = store
          .getTimeline(run!.runtimeRunId)
          .filter((event) =>
            [
              "agent.turn.abandoned",
              "agent.turn.blocked",
              "agent.turn.cancelled",
              "agent.turn.failed",
              "agent.turn.succeeded",
            ].includes(event.eventType),
          );
        expect(terminalEvents).toEqual([
          expect.objectContaining({ eventType: "agent.turn.succeeded" }),
        ]);
        expect(
          store.listRefs(run!.runtimeRunId).filter((ref) => ref.refKind !== "input"),
        ).toHaveLength(1);
      } finally {
        store.close();
      }
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("rolls back the complete intake when received-event persistence fails", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-durable-agent-intake-rollback-"));
    const env = {
      ...process.env,
      OPENCLAW_STATE_DIR: dir,
    };
    const dbPath = resolveDurableRuntimeSqlitePath(env);

    try {
      const setupStore = openDurableRuntimeStore({ env });
      setupStore.close();
      const { DatabaseSync } = requireNodeSqlite();
      const faultDb = new DatabaseSync(dbPath);
      try {
        faultDb.exec(`
          CREATE TRIGGER abort_agent_turn_received_event
          BEFORE INSERT ON durable_event_evidence
          WHEN NEW.event_type = 'agent.turn.received'
          BEGIN
            SELECT RAISE(ABORT, 'fault-injected agent intake event');
          END;
        `);
      } finally {
        faultDb.close();
      }

      expect(() =>
        startDurableAgentTurnLifecycle({
          runId: "agent-run-intake-rollback",
          message: "admit this atomically",
          sessionKey: "agent:main:main",
          transport: "gateway",
          config: authorityConfig,
          env,
        }),
      ).toThrow(/fault-injected agent intake event/);

      const store = openDurableRuntimeStore({ env });
      try {
        expect(store.getStats()).toMatchObject({ runs: 0, events: 0, steps: 0 });
        expect(store.listRuns()).toEqual([]);
      } finally {
        store.close();
      }
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("rolls back a partial terminal transition and permits one clean retry", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-durable-agent-terminal-rollback-"));
    const env = {
      ...process.env,
      OPENCLAW_STATE_DIR: dir,
    };
    const dbPath = resolveDurableRuntimeSqlitePath(env);

    try {
      const lifecycle = startDurableAgentTurnLifecycle({
        runId: "agent-run-terminal-rollback",
        message: "settle this atomically",
        sessionKey: "agent:main:main",
        transport: "gateway",
        config: observeConfig,
        env,
      });
      lifecycle.markRunning();

      const { DatabaseSync } = requireNodeSqlite();
      const faultDb = new DatabaseSync(dbPath);
      try {
        faultDb.exec(`
          CREATE TRIGGER abort_agent_turn_terminal_event
          BEFORE INSERT ON durable_event_evidence
          WHEN NEW.event_type = 'agent.turn.succeeded'
          BEGIN
            SELECT RAISE(ABORT, 'fault-injected agent terminal event');
          END;
        `);
      } finally {
        faultDb.close();
      }

      lifecycle.markTerminal({
        status: "succeeded",
        eventType: "agent.turn.succeeded",
        payload: { summary: "first attempt" },
      });

      const afterFault = openDurableRuntimeStore({ env });
      try {
        const run = afterFault.getRunByIdempotencyKey(
          DURABLE_AGENT_TURN_OPERATION_KIND,
          "agent-run-terminal-rollback",
        );
        expect(run).toMatchObject({ status: "running", recoveryState: "running" });
        expect(afterFault.listRefs(run!.runtimeRunId).map((ref) => ref.refKind)).toEqual(["input"]);
        expect(
          afterFault.getTimeline(run!.runtimeRunId).map((event) => event.eventType),
        ).not.toContain("agent.turn.succeeded");
      } finally {
        afterFault.close();
      }

      const repairDb = new DatabaseSync(dbPath);
      try {
        repairDb.exec("DROP TRIGGER abort_agent_turn_terminal_event");
      } finally {
        repairDb.close();
      }
      lifecycle.markTerminal({
        status: "succeeded",
        eventType: "agent.turn.succeeded",
        payload: { summary: "retry succeeded" },
      });
      lifecycle.close();

      const store = openDurableRuntimeStore({ env });
      try {
        const run = store.getRunByIdempotencyKey(
          DURABLE_AGENT_TURN_OPERATION_KIND,
          "agent-run-terminal-rollback",
        );
        expect(run).toMatchObject({ status: "succeeded", recoveryState: "terminal" });
        expect(
          store
            .getTimeline(run!.runtimeRunId)
            .filter((event) => event.eventType === "agent.turn.succeeded"),
        ).toHaveLength(1);
        expect(store.listRefs(run!.runtimeRunId).map((ref) => ref.refKind)).toEqual([
          "input",
          "output",
        ]);
      } finally {
        store.close();
      }
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("persists a bounded intake envelope on the run, input ref, and initial step", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-durable-agent-turn-"));
    const env = {
      ...process.env,
      OPENCLAW_STATE_DIR: dir,
    };

    try {
      const lifecycle = startDurableAgentTurnLifecycle({
        runId: "agent-run-1",
        message: "summarize this session task",
        agentId: "bo",
        sessionKey: "agent:bo:main",
        channel: "discord",
        transport: "gateway",
        contextRefs: [{ type: "task", id: "task-1" }],
        config: observeConfig,
        env,
      });
      lifecycle.close();

      const store = openDurableRuntimeStore({ env });
      try {
        const run = store.getRunByIdempotencyKey(DURABLE_AGENT_TURN_OPERATION_KIND, "agent-run-1");
        expect(run).toMatchObject({
          operationKind: DURABLE_AGENT_TURN_OPERATION_KIND,
          idempotencyKey: "agent-run-1",
          metadata: {
            intakeEnvelope: expect.objectContaining({
              schema: DURABLE_INTAKE_ENVELOPE_SCHEMA,
              runId: "agent-run-1",
              sourceOwner: "session_store",
              sessionKey: "agent:bo:main",
              message: { length: 27, hash: expect.any(String) },
              replay: expect.objectContaining({
                inputAvailability: "metadata_only",
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
    };

    try {
      const lifecycle = startDurableAgentTurnLifecycle({
        runId: "agent-run-yielded",
        message: "coordinate a child agent",
        agentId: "bo",
        sessionKey: "agent:bo:main",
        transport: "gateway",
        config: observeConfig,
        env,
      });
      lifecycle.markRunning();

      const setupStore = openDurableRuntimeStore({ env });
      try {
        const [parent] = setupStore.listRuns({ limit: 10 });
        const child = setupStore.createRun({
          operationKind: "openclaw.subagent.run",
          sourceOwner: "subagent_runs",
          sourceRef: "agent-run-yielded-child",
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
        const run = store.getRunByIdempotencyKey(
          DURABLE_AGENT_TURN_OPERATION_KIND,
          "agent-run-yielded",
        );
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
    };

    try {
      const lifecycle = startDurableAgentTurnLifecycle({
        runId: "agent-run-waiting-signal",
        message: "pause until human follows up",
        agentId: "bo",
        sessionKey: "agent:bo:main",
        transport: "gateway",
        config: observeConfig,
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
