// Octopus Orchestrator -- Task ledger bridge tests (M2-12)
//
// Covers:
//   - createTaskRef returns a ref string
//   - syncStatus updates the mock store
//   - resolveTaskRef round-trips correctly
//   - resolveTaskRef returns null for unknown ref
//   - mock tracks all calls
//   - createTaskRef with different runtimes stores correctly

import { describe, expect, it } from "vitest";
import { createMockTaskLedgerBridge } from "./task-ledger.ts";

describe("TaskLedgerBridge (mock)", () => {
  it("createTaskRef returns a ref string", async () => {
    const bridge = createMockTaskLedgerBridge();
    const ref = await bridge.createTaskRef("arm-1", "agent-a", "subagent");
    expect(typeof ref).toBe("string");
    expect(ref.length).toBeGreaterThan(0);
  });

  it("syncStatus updates the mock store", async () => {
    const bridge = createMockTaskLedgerBridge();
    const ref = await bridge.createTaskRef("arm-2", "agent-b", "subagent");
    await bridge.syncStatus(ref, "running");
    const entry = bridge.refs.get(ref);
    expect(entry).not.toBeNull();
    expect(entry?.status).toBe("running");
  });

  it("resolveTaskRef round-trips correctly", async () => {
    const bridge = createMockTaskLedgerBridge();
    const ref = await bridge.createTaskRef("arm-3", "agent-c", "acp");
    await bridge.syncStatus(ref, "completed");
    const resolved = await bridge.resolveTaskRef(ref);
    expect(resolved).not.toBeNull();
    expect(resolved?.status).toBe("completed");
    expect(resolved?.runtime).toBe("acp");
    expect(typeof resolved?.taskId).toBe("string");
  });

  it("resolveTaskRef returns null for unknown ref", async () => {
    const bridge = createMockTaskLedgerBridge();
    const resolved = await bridge.resolveTaskRef("tref-nonexistent-999");
    expect(resolved).toBeNull();
  });

  it("mock tracks all calls", async () => {
    const bridge = createMockTaskLedgerBridge();
    const ref = await bridge.createTaskRef("arm-4", "agent-d", "subagent");
    await bridge.syncStatus(ref, "running");
    await bridge.resolveTaskRef(ref);

    expect(bridge.calls.createTaskRef).toHaveLength(1);
    expect(bridge.calls.createTaskRef[0]).toEqual(["arm-4", "agent-d", "subagent"]);
    expect(bridge.calls.syncStatus).toHaveLength(1);
    expect(bridge.calls.syncStatus[0]).toEqual([ref, "running"]);
    expect(bridge.calls.resolveTaskRef).toHaveLength(1);
    expect(bridge.calls.resolveTaskRef[0]).toEqual([ref]);
  });

  it("createTaskRef with different runtimes stores correctly", async () => {
    const bridge = createMockTaskLedgerBridge();
    const refSub = await bridge.createTaskRef("arm-5", "agent-e", "subagent");
    const refAcp = await bridge.createTaskRef("arm-6", "agent-f", "acp");

    const entrySub = bridge.refs.get(refSub);
    const entryAcp = bridge.refs.get(refAcp);

    expect(entrySub?.runtime).toBe("subagent");
    expect(entryAcp?.runtime).toBe("acp");
    expect(refSub).not.toBe(refAcp);
  });
});
