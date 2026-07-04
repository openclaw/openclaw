import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { buildDurableFanInSnapshotForChild } from "./fan-in-snapshot.js";
import { buildDurableFanInGroupId } from "./fan-in.js";
import { upsertDurableChildResultMailbox } from "./result-mailbox.js";
import { openDurableRuntimeSqliteStore } from "./sqlite-store.js";

describe("durable fan-in snapshots", () => {
  it("groups children by durable parent fan-in step instead of timestamp proximity", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-durable-fanin-snapshot-"));
    const dbPath = path.join(dir, "state", "openclaw.sqlite");
    const env = {
      ...process.env,
      OPENCLAW_DURABLE_RUNTIME: "1",
      OPENCLAW_STATE_DIR: dir,
    };
    const store = openDurableRuntimeSqliteStore({ path: dbPath });
    try {
      const parent = store.createRun({
        operationKind: "openclaw.agent.turn",
        status: "waiting_child",
        recoveryState: "waiting_child",
        idempotencyKey: "run_parent",
        now: 100,
      });
      const parentStepId = "subagents";
      const fanInGroupId = buildDurableFanInGroupId({
        parentRuntimeRunId: parent.runtimeRunId,
        parentStepId,
      });
      store.createStep({
        runtimeRunId: parent.runtimeRunId,
        stepId: parentStepId,
        stepType: "fan_in",
        status: "waiting",
        recoveryState: "waiting_child",
        metadata: { fanInGroupId, policy: "continue_on_child_failure" },
        now: 100,
      });
      const childA = store.createRun({
        operationKind: "openclaw.subagent.run",
        status: "succeeded",
        recoveryState: "terminal",
        idempotencyKey: "run_child_a",
        sourceType: "subagent",
        sourceRef: "agent:bo:subagent:a",
        parentRuntimeRunId: parent.runtimeRunId,
        parentStepId,
        metadata: { childSessionKey: "agent:bo:subagent:a" },
        completedAt: 120,
        now: 120,
      });
      const childB = store.createRun({
        operationKind: "openclaw.subagent.run",
        status: "running",
        recoveryState: "running",
        idempotencyKey: "run_child_b",
        sourceType: "subagent",
        sourceRef: "agent:bo:subagent:b",
        parentRuntimeRunId: parent.runtimeRunId,
        parentStepId,
        metadata: { childSessionKey: "agent:bo:subagent:b" },
        now: 10_900_000,
      });
      store.createLink({
        parentRuntimeRunId: parent.runtimeRunId,
        parentStepId,
        childRuntimeRunId: childA.runtimeRunId,
        linkType: "subagent",
        status: "succeeded",
        metadata: { fanInGroupId, childSessionKey: "agent:bo:subagent:a", summary: "A done" },
        now: 121,
      });
      store.createLink({
        parentRuntimeRunId: parent.runtimeRunId,
        parentStepId,
        childRuntimeRunId: childB.runtimeRunId,
        linkType: "subagent",
        status: "running",
        metadata: { fanInGroupId, childSessionKey: "agent:bo:subagent:b" },
        now: 10_900_001,
      });
      upsertDurableChildResultMailbox({
        store,
        parentRuntimeRunId: parent.runtimeRunId,
        parentStepId,
        childRuntimeRunId: childA.runtimeRunId,
        childSessionKey: "agent:bo:subagent:a",
        linkStatus: "succeeded",
        terminalStatus: "ok",
        terminalOutcome: "succeeded",
        summary: "A done",
        now: 122,
      });
    } finally {
      store.close();
    }

    const snapshot = buildDurableFanInSnapshotForChild({
      childRunId: "run_child_a",
      childSessionKey: "agent:bo:subagent:a",
      currentFindings: "A done",
      env,
    });

    try {
      expect(snapshot).toMatchObject({
        total: 2,
        terminalCount: 1,
        pendingCount: 1,
        snapshotTruncated: false,
        allListedChildrenTerminal: false,
      });
      expect(snapshot?.text).toContain("Durable fan-in snapshot");
      expect(snapshot?.text).toContain("agent:bo:subagent:a");
      expect(snapshot?.text).toContain("agent:bo:subagent:b");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("identifies the final terminal child by durable link state", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-durable-fanin-snapshot-"));
    const dbPath = path.join(dir, "state", "openclaw.sqlite");
    const env = {
      ...process.env,
      OPENCLAW_DURABLE_RUNTIME: "1",
      OPENCLAW_STATE_DIR: dir,
    };
    const store = openDurableRuntimeSqliteStore({ path: dbPath });
    try {
      const parent = store.createRun({
        operationKind: "openclaw.agent.turn",
        status: "waiting_child",
        recoveryState: "waiting_child",
        idempotencyKey: "run_parent",
        now: 100,
      });
      const parentStepId = "subagents";
      const fanInGroupId = buildDurableFanInGroupId({
        parentRuntimeRunId: parent.runtimeRunId,
        parentStepId,
      });
      store.createStep({
        runtimeRunId: parent.runtimeRunId,
        stepId: parentStepId,
        stepType: "fan_in",
        status: "waiting",
        recoveryState: "waiting_child",
        metadata: { fanInGroupId, policy: "continue_on_child_failure" },
        now: 100,
      });
      const childA = store.createRun({
        operationKind: "openclaw.subagent.run",
        status: "succeeded",
        recoveryState: "terminal",
        idempotencyKey: "run_child_a",
        sourceRef: "agent:bo:subagent:a",
        metadata: { childSessionKey: "agent:bo:subagent:a" },
        completedAt: 120,
        now: 120,
      });
      const childB = store.createRun({
        operationKind: "openclaw.subagent.run",
        status: "failed",
        recoveryState: "terminal",
        idempotencyKey: "run_child_b",
        sourceRef: "agent:bo:subagent:b",
        metadata: { childSessionKey: "agent:bo:subagent:b" },
        completedAt: 10_900_000,
        now: 10_900_000,
      });
      store.createLink({
        parentRuntimeRunId: parent.runtimeRunId,
        parentStepId,
        childRuntimeRunId: childA.runtimeRunId,
        linkType: "subagent",
        status: "succeeded",
        metadata: { fanInGroupId, childSessionKey: "agent:bo:subagent:a", summary: "A done" },
        now: 121,
      });
      store.createLink({
        parentRuntimeRunId: parent.runtimeRunId,
        parentStepId,
        childRuntimeRunId: childB.runtimeRunId,
        linkType: "subagent",
        status: "failed",
        metadata: { fanInGroupId, childSessionKey: "agent:bo:subagent:b", error: "B failed" },
        now: 10_900_001,
      });
    } finally {
      store.close();
    }

    const snapshotForA = buildDurableFanInSnapshotForChild({
      childRunId: "run_child_a",
      childSessionKey: "agent:bo:subagent:a",
      currentFindings: "A done",
      env,
    });
    const snapshotForB = buildDurableFanInSnapshotForChild({
      childRunId: "run_child_b",
      childSessionKey: "agent:bo:subagent:b",
      currentFindings: "B failed",
      env,
    });

    try {
      expect(snapshotForA).toMatchObject({
        total: 2,
        terminalCount: 2,
        pendingCount: 0,
        allListedChildrenTerminal: true,
        currentChildOwnsFinal: false,
      });
      expect(snapshotForB).toMatchObject({
        total: 2,
        terminalCount: 2,
        pendingCount: 0,
        allListedChildrenTerminal: true,
        currentChildOwnsFinal: true,
      });
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
