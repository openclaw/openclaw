import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { ErrorCodes } from "../../../packages/gateway-protocol/src/index.js";
import {
  resetConfigRuntimeState,
  setRuntimeConfigSnapshot,
} from "../../config/runtime-snapshot.js";
import { openDurableRuntimeSqliteStore } from "../../durable/sqlite-store.js";
import { CORE_GATEWAY_METHOD_SPECS } from "../methods/core-descriptors.js";
import { durableHandlers } from "./durable.js";

describe("durable gateway methods", () => {
  it("advertises only read-authorized durable methods", () => {
    const specs = CORE_GATEWAY_METHOD_SPECS.filter((spec) => spec.name.startsWith("durable."));
    expect(specs.map((spec) => spec.name)).toEqual([
      "durable.health.get",
      "durable.coordination.get",
      "durable.obligations.list",
      "durable.wakes.list",
      "durable.wakes.inspect",
      "durable.uncertainty.list",
      "durable.deliveryAttempts.list",
    ]);
    expect(specs.every((spec) => spec.scope === "operator.read")).toBe(true);
    expect(specs.every((spec) => !spec.controlPlaneWrite)).toBe(true);
    expect(specs.some((spec) => /ack|retry|resume|replay|resolve|abandon/i.test(spec.name))).toBe(
      false,
    );
  });

  it("reports enabled but uninitialized durable health without creating state", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-durable-gateway-health-"));
    const dbPath = path.join(dir, "state", "openclaw.sqlite");
    const previousStateDir = process.env.OPENCLAW_STATE_DIR;
    setRuntimeConfigSnapshot({ durable: { mode: "observe" } });
    process.env.OPENCLAW_STATE_DIR = dir;
    const calls: unknown[][] = [];
    try {
      await durableHandlers["durable.health.get"]?.({
        params: {},
        respond: (...args: unknown[]) => calls.push(args),
      } as never);
      expect(calls).toEqual([
        [
          true,
          expect.objectContaining({
            enabled: true,
            ready: false,
            storeError: expect.stringMatching(/not initialized/),
          }),
        ],
      ]);
      expect(JSON.stringify(calls)).not.toContain(dir);
      const inspectionCalls: unknown[][] = [];
      await durableHandlers["durable.obligations.list"]?.({
        params: { limit: 10 },
        respond: (...args: unknown[]) => inspectionCalls.push(args),
      } as never);
      expect(inspectionCalls).toEqual([
        [
          false,
          undefined,
          expect.objectContaining({
            code: ErrorCodes.UNAVAILABLE,
            message: expect.stringMatching(/not initialized/),
          }),
        ],
      ]);
      expect(JSON.stringify(inspectionCalls)).not.toContain(dir);
      expect(fs.existsSync(dbPath)).toBe(false);
    } finally {
      resetConfigRuntimeState();
      if (previousStateDir === undefined) {
        delete process.env.OPENCLAW_STATE_DIR;
      } else {
        process.env.OPENCLAW_STATE_DIR = previousStateDir;
      }
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("exposes bounded source-backed obligation inspection", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-durable-gateway-"));
    const dbPath = path.join(dir, "state", "openclaw.sqlite");
    const previousStateDir = process.env.OPENCLAW_STATE_DIR;
    setRuntimeConfigSnapshot({ durable: { mode: "observe" } });
    process.env.OPENCLAW_STATE_DIR = dir;
    const store = openDurableRuntimeSqliteStore({ path: dbPath });
    let storeClosed = false;
    try {
      const wake = store.createWakeObligation({
        sourceOwner: "subagent_runs",
        sourceRef: "subagent-1",
        targetKind: "agent_session",
        targetRef: "agent:test:main",
        ownerKind: "agent_session",
        ownerRef: "agent:test:main",
        targetResolutionStatus: "resolved",
        reason: "child_terminal",
        dedupeKey: "subagent-terminal:subagent-1:agent:test:main",
        metadata: {
          diagnostics: { privateMarker: "DO_NOT_EXPOSE" },
          evidence: { privateMarker: "DO_NOT_EXPOSE" },
        },
        now: 100,
      });
      const fact = store.recordUncertaintyFact({
        sourceOwner: "subagent_runs",
        sourceRef: "subagent-1",
        kind: "lost_after_dispatch",
        dedupeKey: "lost:subagent-1",
        facts: { privateMarker: "DO_NOT_EXPOSE" },
        metadata: { privateMarker: "DO_NOT_EXPOSE" },
        now: 110,
      });
      const claim = store.claimNextWakeObligation({
        workerId: "gateway-test",
        claimTtlMs: 1_000,
        retryBaseMs: 1_000,
        retryMaxMs: 60_000,
        now: 120,
      });
      expect(claim).toBeDefined();
      const attempt = store.completeWakeObligationClaim({
        wakeId: wake.wakeId,
        deliveryAttemptId: claim!.deliveryAttempt.deliveryAttemptId,
        claimToken: claim!.claimToken,
        attemptStatus: "failed",
        wakeStatus: "failed",
        error: "requester unavailable",
        now: 120,
      });
      expect(attempt).toBeDefined();
      store.close();
      storeClosed = true;

      const exposed: unknown[] = [];
      const invoke = async (
        method: keyof typeof durableHandlers,
        params: Record<string, unknown>,
      ) => {
        const calls: unknown[][] = [];
        await durableHandlers[method]?.({
          params,
          respond: (...args: unknown[]) => calls.push(args),
        } as never);
        expect(calls).toHaveLength(1);
        expect(calls[0]?.[0]).toBe(true);
        exposed.push(calls[0]?.[1]);
        return calls[0]?.[1];
      };

      expect(await invoke("durable.obligations.list", { limit: 10 })).toMatchObject({
        obligations: expect.arrayContaining([
          expect.objectContaining({ wakeId: wake.wakeId, sourceOwner: "subagent_runs" }),
          expect.objectContaining({
            uncertaintyFactId: fact.factId,
            sourceRef: "subagent-1",
          }),
        ]),
      });
      expect(await invoke("durable.wakes.list", { limit: 10 })).toMatchObject({
        wakes: [expect.objectContaining({ wakeId: wake.wakeId })],
      });
      expect(await invoke("durable.wakes.inspect", { wakeId: wake.wakeId })).toMatchObject({
        inspection: {
          wake: { wakeId: wake.wakeId },
          unresolvedUncertainty: [expect.objectContaining({ factId: fact.factId })],
        },
      });
      expect(await invoke("durable.uncertainty.list", { limit: 10 })).toMatchObject({
        uncertaintyFacts: [expect.objectContaining({ factId: fact.factId })],
      });
      expect(
        await invoke("durable.deliveryAttempts.list", { wakeId: wake.wakeId, limit: 10 }),
      ).toMatchObject({
        deliveryAttemptEvidence: [
          expect.objectContaining({ deliveryAttemptId: attempt!.deliveryAttemptId }),
        ],
      });
      const serialized = JSON.stringify(exposed);
      expect(serialized).not.toContain("DO_NOT_EXPOSE");
      expect(serialized).not.toContain("subagent-terminal:subagent-1:agent:test:main");
      expect(serialized).not.toContain("wake_claim_");
    } finally {
      if (!storeClosed) {
        store.close();
      }
      resetConfigRuntimeState();
      if (previousStateDir === undefined) {
        delete process.env.OPENCLAW_STATE_DIR;
      } else {
        process.env.OPENCLAW_STATE_DIR = previousStateDir;
      }
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("returns coordination projection for a durable runtime run", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-durable-gateway-"));
    const dbPath = path.join(dir, "state", "openclaw.sqlite");
    const previousStateDir = process.env.OPENCLAW_STATE_DIR;
    setRuntimeConfigSnapshot({ durable: { mode: "observe" } });
    process.env.OPENCLAW_STATE_DIR = dir;
    const store = openDurableRuntimeSqliteStore({ path: dbPath });
    let storeClosed = false;
    try {
      const parent = store.createRun({
        operationKind: "test.parent",
        rootOperationReason: "test-root",
        status: "waiting_child",
        recoveryState: "waiting_child",
        metadata: {
          taskId: "task-parent",
          taskFlowId: "flow-parent",
          sessionKey: "agent:bo:main",
        },
        now: 100,
      });
      store.createStep({
        runtimeRunId: parent.runtimeRunId,
        stepId: "subagents",
        stepType: "fan_in",
        status: "waiting",
        recoveryState: "waiting_child",
        now: 110,
      });
      const child = store.createRun({
        operationKind: "test.child",
        rootOperationReason: "test-root",
        status: "succeeded",
        recoveryState: "terminal",
        now: 120,
      });
      store.createLink({
        parentRuntimeRunId: parent.runtimeRunId,
        parentStepId: "subagents",
        childRuntimeRunId: child.runtimeRunId,
        linkType: "subagent",
        status: "succeeded",
        now: 130,
      });
      store.close();
      storeClosed = true;

      const calls: unknown[][] = [];
      await durableHandlers["durable.coordination.get"]?.({
        params: { runtimeRunId: parent.runtimeRunId },
        respond: (...args: unknown[]) => calls.push(args),
      } as never);

      expect(calls).toHaveLength(1);
      expect(calls[0]?.[0]).toBe(true);
      expect(calls[0]?.[1]).toMatchObject({
        projection: {
          runtimeRunId: parent.runtimeRunId,
          waitingReason: "child",
          currentStepId: "subagents",
          external: {
            taskId: "task-parent",
            taskFlowId: "flow-parent",
            sessionKey: "agent:bo:main",
          },
          children: {
            total: 1,
            succeeded: 1,
            terminal: 1,
            open: 0,
          },
        },
      });
    } finally {
      if (!storeClosed) {
        store.close();
      }
      resetConfigRuntimeState();
      if (previousStateDir === undefined) {
        delete process.env.OPENCLAW_STATE_DIR;
      } else {
        process.env.OPENCLAW_STATE_DIR = previousStateDir;
      }
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("does not create durable state when the feature is disabled", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-durable-disabled-"));
    const previousStateDir = process.env.OPENCLAW_STATE_DIR;
    resetConfigRuntimeState();
    process.env.OPENCLAW_STATE_DIR = dir;
    try {
      const calls: unknown[][] = [];
      await durableHandlers["durable.coordination.get"]?.({
        params: { runtimeRunId: "rt_disabled" },
        respond: (...args: unknown[]) => calls.push(args),
      } as never);

      expect(calls).toHaveLength(1);
      expect(calls[0]?.[0]).toBe(false);
      const healthCalls: unknown[][] = [];
      await durableHandlers["durable.health.get"]?.({
        params: {},
        respond: (...args: unknown[]) => healthCalls.push(args),
      } as never);
      expect(healthCalls).toEqual([
        [
          true,
          expect.objectContaining({
            enabled: false,
            authority: false,
            ready: false,
          }),
        ],
      ]);
      expect(fs.existsSync(path.join(dir, "state", "openclaw.sqlite"))).toBe(false);
    } finally {
      resetConfigRuntimeState();
      if (previousStateDir === undefined) {
        delete process.env.OPENCLAW_STATE_DIR;
      } else {
        process.env.OPENCLAW_STATE_DIR = previousStateDir;
      }
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("rejects invalid coordination params before opening durable state", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-durable-invalid-"));
    const previousStateDir = process.env.OPENCLAW_STATE_DIR;
    setRuntimeConfigSnapshot({ durable: { mode: "observe" } });
    process.env.OPENCLAW_STATE_DIR = dir;
    try {
      const calls: unknown[][] = [];
      await durableHandlers["durable.coordination.get"]?.({
        params: { runtimeRunId: "", includeSteps: true },
        respond: (...args: unknown[]) => calls.push(args),
      } as never);

      expect(calls).toHaveLength(1);
      expect(calls[0]?.[0]).toBe(false);
      expect(fs.existsSync(path.join(dir, "state", "openclaw.sqlite"))).toBe(false);
    } finally {
      resetConfigRuntimeState();
      if (previousStateDir === undefined) {
        delete process.env.OPENCLAW_STATE_DIR;
      } else {
        process.env.OPENCLAW_STATE_DIR = previousStateDir;
      }
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
