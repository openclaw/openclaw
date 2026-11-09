import { describe, expect, it, vi } from "vitest";
import type { GatewayClient } from "./client-types.js";
import {
  admitSimulatorInvoke,
  cleanupSimulatorNodeSession,
  completeSimulatorInvoke,
  isSimulatorAdmissionCurrent,
} from "./nodes.simulator-lease.js";

function viewer() {
  const controller = new AbortController();
  return {
    controller,
    client: { connectionSignal: controller.signal, invalidated: false } as GatewayClient,
  };
}

function cleanupSpy() {
  return vi.fn((_lease: unknown) => {});
}

function start(params: {
  nodeId: string;
  client: GatewayClient;
  executionId: string;
  cleanup: Parameters<typeof admitSimulatorInvoke>[0]["cleanup"];
  isClientCurrent?: () => boolean;
  connId?: string;
}) {
  return admitSimulatorInvoke({
    nodeId: params.nodeId,
    command: "simulator.capture",
    input: { action: "start", executionId: params.executionId },
    client: params.client,
    connId: params.connId ?? "conn-1",
    pairingGeneration: "pair-1",
    isClientCurrent: params.isClientCurrent ?? (() => true),
    cleanup: params.cleanup,
  });
}

describe("Simulator Gateway lease", () => {
  it("keeps frames and input with the opening connection and releases on disconnect", () => {
    const nodeId = crypto.randomUUID();
    const executionId = crypto.randomUUID();
    const first = viewer();
    const second = viewer();
    const cleanup = cleanupSpy();
    const admission = start({ nodeId, client: first.client, executionId, cleanup });
    expect(admission).toHaveProperty("started", true);
    if (!("lease" in admission)) return;
    expect(
      completeSimulatorInvoke(
        admission,
        "simulator.capture",
        { action: "start" },
        {
          ok: true,
          payloadJSON: JSON.stringify({ sessionId: "session-1" }),
        },
      ),
    ).toBeUndefined();
    expect(
      start({ nodeId, client: second.client, executionId: crypto.randomUUID(), cleanup }),
    ).toHaveProperty("error");
    const read = admitSimulatorInvoke({
      nodeId,
      command: "simulator.capture",
      input: { action: "read", sessionId: "session-1", executionId },
      client: first.client,
      connId: "conn-1",
      pairingGeneration: "pair-1",
      isClientCurrent: () => true,
      cleanup,
    });
    expect(read).toHaveProperty("started", false);
    const foreignInput = admitSimulatorInvoke({
      nodeId,
      command: "simulator.act",
      input: { action: "left_click", sessionId: "session-1", executionId },
      client: second.client,
      connId: "conn-1",
      pairingGeneration: "pair-1",
      isClientCurrent: () => true,
      cleanup,
    });
    expect(foreignInput).toHaveProperty("error");
    first.controller.abort();
    expect(isSimulatorAdmissionCurrent(admission)).toBe(false);
    expect(cleanup).toHaveBeenCalledOnce();
    expect(cleanup.mock.calls[0]?.[0]).toMatchObject({ sessionId: "session-1", executionId });
  });

  it("rejects a changed node connection and oversized frame", () => {
    const nodeId = crypto.randomUUID();
    const executionId = crypto.randomUUID();
    const first = viewer();
    const cleanup = cleanupSpy();
    const admission = start({ nodeId, client: first.client, executionId, cleanup });
    if (!("lease" in admission)) throw new Error("expected lease");
    completeSimulatorInvoke(
      admission,
      "simulator.capture",
      { action: "start" },
      {
        ok: true,
        payloadJSON: JSON.stringify({ sessionId: "session-2" }),
      },
    );
    const moved = admitSimulatorInvoke({
      nodeId,
      command: "simulator.act",
      input: { action: "left_click", sessionId: "session-2", executionId },
      client: first.client,
      connId: "conn-2",
      pairingGeneration: "pair-1",
      isClientCurrent: () => true,
      cleanup,
    });
    expect(moved).toHaveProperty("error");
    expect(cleanup).toHaveBeenCalledOnce();
    const next = start({
      nodeId,
      client: first.client,
      executionId: crypto.randomUUID(),
      cleanup,
      connId: "conn-2",
    });
    if (!("lease" in next)) throw new Error("expected lease");
    expect(
      completeSimulatorInvoke(
        next,
        "simulator.capture",
        { action: "start" },
        {
          ok: true,
          payloadJSON: "x".repeat(8_000_001),
        },
      ),
    ).toMatch(/transport limit/);
    expect(cleanup).toHaveBeenCalledTimes(2);
  });

  it("drops a frame when viewer authority closes during the node invoke", () => {
    const nodeId = crypto.randomUUID();
    const executionId = crypto.randomUUID();
    const first = viewer();
    let authorized = true;
    const cleanup = cleanupSpy();
    const admission = start({
      nodeId,
      client: first.client,
      executionId,
      cleanup,
      isClientCurrent: () => authorized,
    });
    if (!("lease" in admission)) throw new Error("expected lease");
    completeSimulatorInvoke(
      admission,
      "simulator.capture",
      { action: "start" },
      {
        ok: true,
        payloadJSON: JSON.stringify({ sessionId: "session-3" }),
      },
    );
    const read = admitSimulatorInvoke({
      nodeId,
      command: "simulator.capture",
      input: { action: "read", sessionId: "session-3", executionId },
      client: first.client,
      connId: "conn-1",
      pairingGeneration: "pair-1",
      isClientCurrent: () => authorized,
      cleanup,
    });
    if (!("lease" in read)) throw new Error("expected read lease");
    authorized = false;
    expect(
      completeSimulatorInvoke(
        read,
        "simulator.capture",
        { action: "read" },
        {
          ok: true,
          payloadJSON: JSON.stringify({ sessionId: "session-3", jpegBase64: "private-frame" }),
        },
      ),
    ).toMatch(/connection ended/);
    expect(cleanup).toHaveBeenCalledOnce();
  });

  it("closes held input before stopping capture on viewer loss", async () => {
    const nodeId = crypto.randomUUID();
    const executionId = crypto.randomUUID();
    const first = viewer();
    const admission = start({ nodeId, client: first.client, executionId, cleanup: cleanupSpy() });
    if (!("lease" in admission)) throw new Error("expected lease");
    completeSimulatorInvoke(
      admission,
      "simulator.capture",
      { action: "start" },
      {
        ok: true,
        payloadJSON: JSON.stringify({ sessionId: "session-4" }),
      },
    );
    const commands: string[] = [];
    await cleanupSimulatorNodeSession(admission.lease, async (params) => {
      commands.push(params.command);
      return { ok: true };
    });
    expect(commands).toEqual(["computer.act", "simulator.capture"]);
    first.controller.abort();
  });
});
