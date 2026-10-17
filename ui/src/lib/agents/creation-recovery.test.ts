import { describe, expect, it, onTestFinished, vi } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.js";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import { createGatewayHarness } from "../config/config-test-harness.ts";
import { agentCreationRejection } from "./creation.test-support.ts";
import { createAgentCapability } from "./index.ts";

function fixture() {
  const roster = { defaultId: "main", agents: [{ id: "main", name: "Existing agent" }] };
  const request = vi.fn<(method: string, params?: unknown) => Promise<unknown>>();
  request.mockResolvedValueOnce(roster);
  // SAFETY: Only the request and immutable Gateway target are consumed by this capability.
  const client = { request, gatewayUrl: "ws://original.test" } as unknown as GatewayBrowserClient;
  const harness = createGatewayHarness(client);
  const agents = createAgentCapability(harness.gateway);
  onTestFinished(() => agents.dispose());
  return { agents, request, harness, roster };
}

function savedAgent(agentId: string) {
  return {
    exists: true,
    valid: true,
    sourceConfig: {
      agents: { entries: { [agentId]: { name: "Recovered name" } } },
      session: { mainKey: "home" },
    },
  };
}
const absentAgent = { exists: true, valid: true, sourceConfig: {} };

describe("agent creation outcome recovery", () => {
  it("does not retain an unsent attempt after disconnecting before dispatch", async () => {
    const { agents, request, harness, roster } = fixture();
    await agents.ensureList();
    const original = agents.create("New agent");
    const unsentId = agents.state.pendingAgent!.id;
    harness.publish(false);
    await expect(original).resolves.toBeNull();
    expect(request).toHaveBeenCalledOnce();

    harness.publish(true);
    request.mockResolvedValueOnce(roster);
    request.mockImplementationOnce(async (_method, params) => {
      const { agentId } = params as { agentId: string };
      return {
        agentId,
        name: "New agent",
        onboarding: { status: "completed", sessionKey: `agent:${agentId}:main` },
      };
    });
    const result = await agents.create("New agent");
    expect(result?.agentId).not.toBe(unsentId);
    expect(request.mock.calls.map(([method]) => method)).toEqual([
      "agents.list",
      "agents.list",
      "agents.create",
    ]);
  });

  it("does not let an old receipt finish a newer recovery of the same agent", async () => {
    const { agents, request, harness } = fixture();
    await agents.ensureList();
    const oldResponse = createDeferred<unknown>();
    const recoveryRead = createDeferred<unknown>();
    const creationStarted = createDeferred();
    request.mockImplementationOnce(() => {
      creationStarted.resolve();
      return oldResponse.promise;
    });
    const original = agents.create("New agent");
    const agentId = agents.state.pendingAgent!.id;
    await creationStarted.promise;
    harness.publish(false);
    harness.publish(true);
    request.mockResolvedValueOnce({ defaultId: "main", agents: [] });
    request.mockReturnValueOnce(recoveryRead.promise);
    const recovery = agents.create("New agent");
    await vi.waitFor(() => expect(request).toHaveBeenCalledWith("config.get", {}));
    oldResponse.resolve({
      agentId,
      name: "New agent",
      onboarding: { status: "completed", sessionKey: `agent:${agentId}:main` },
    });
    await expect(original).resolves.toBeNull();
    expect(agents.state.pendingAgent).toBeDefined();
    expect(agents.state.pendingAgent?.id).toBe(agentId);
    recoveryRead.resolve(savedAgent(agentId));
    await expect(recovery).resolves.toMatchObject({ agentId });
    expect(agents.state.pendingAgent).toBeUndefined();
    expect(request.mock.calls.filter(([method]) => method === "agents.create")).toHaveLength(1);
  });

  it("recovers a saved agent after a rejected response without claiming its greeting completed", async () => {
    const { agents, request, roster } = fixture();
    await agents.ensureList();
    let attemptedId = "";
    request.mockRejectedValueOnce(agentCreationRejection("Saved but application unconfirmed"));
    request.mockImplementationOnce(async () => savedAgent(attemptedId));
    const result = await agents.create("New agent", (agentId) => {
      attemptedId = agentId;
    });
    expect(result).toMatchObject({
      agentId: attemptedId,
      name: "Recovered name",
      onboarding: { sessionKey: `agent:${attemptedId}:home`, status: "error" },
    });
    expect(agents.state.agentsList?.agents).toEqual([
      { id: attemptedId, name: "Recovered name" },
      ...roster.agents,
    ]);
    expect(request.mock.calls.map(([method]) => method)).toEqual([
      "agents.list",
      "agents.create",
      "config.get",
    ]);
  });

  it("retains an uncertain attempt across reconnect and checks it on retry instead of creating a duplicate", async () => {
    const { agents, request, harness } = fixture();
    await agents.ensureList();
    const started = vi.fn<(agentId: string) => void>();
    request.mockRejectedValueOnce(new Error("Response lost"));
    request.mockResolvedValueOnce(absentAgent);
    await expect(agents.create("New agent", started)).rejects.toThrow("hasn't confirmed");
    const attemptedId = started.mock.calls[0]![0];
    harness.publish(false);
    harness.publish(true);
    request.mockResolvedValueOnce({ defaultId: "main", agents: [] });
    request.mockRejectedValueOnce(new Error("Read unavailable"));
    await expect(agents.create("New agent", started)).rejects.toThrow("hasn't confirmed");
    request.mockResolvedValueOnce(savedAgent(attemptedId));
    await expect(agents.create("New agent", started)).resolves.toMatchObject({
      agentId: attemptedId,
    });
    expect(started.mock.calls).toEqual([[attemptedId], [attemptedId], [attemptedId]]);
    expect(request.mock.calls.filter(([method]) => method === "agents.create")).toHaveLength(1);
  });

  it("permits a fresh identity after a correlated rejection and authoritative absence", async () => {
    const { agents, request } = fixture();
    await agents.ensureList();
    const started = vi.fn<(agentId: string) => void>();
    request.mockRejectedValueOnce(agentCreationRejection("Inference unavailable"));
    request.mockResolvedValueOnce(absentAgent);
    await expect(agents.create("New agent", started)).rejects.toThrow("Inference unavailable");
    request.mockImplementationOnce(async (_method, params) => {
      const { agentId } = params as { agentId: string };
      return {
        agentId,
        name: "New agent",
        onboarding: { status: "completed", sessionKey: `agent:${agentId}:main` },
      };
    });
    await agents.create("New agent", started);
    expect(started.mock.calls[1]![0]).not.toBe(started.mock.calls[0]![0]);
    expect(request.mock.calls.filter(([method]) => method === "agents.create")).toHaveLength(2);
  });

  it("never reconciles an original Gateway's uncertain write against a different Gateway", async () => {
    const { agents, request, harness } = fixture();
    await agents.ensureList();
    const started = vi.fn<(agentId: string) => void>();
    request.mockRejectedValueOnce(new Error("Response lost"));
    request.mockResolvedValueOnce(absentAgent);
    await expect(agents.create("New agent", started)).rejects.toThrow("hasn't confirmed");
    const originalId = started.mock.calls[0]![0];
    const otherRequest = vi
      .fn<(method: string, params?: unknown) => Promise<unknown>>()
      .mockResolvedValueOnce({ defaultId: "main", agents: [] })
      .mockRejectedValueOnce(new Error("Other response lost"))
      .mockResolvedValueOnce(absentAgent);
    // SAFETY: Only the request and immutable Gateway target are consumed here.
    const otherClient = {
      request: otherRequest,
      gatewayUrl: "ws://other.test",
    } as unknown as GatewayBrowserClient;
    harness.publish(true, otherClient);
    await expect(agents.create("New agent", started)).rejects.toThrow("hasn't confirmed");
    expect(started.mock.calls[1]![0]).not.toBe(originalId);
    expect(otherRequest).not.toHaveBeenCalledWith(
      "agents.create",
      expect.objectContaining({ agentId: originalId }),
    );
    harness.publish(true);
    request.mockResolvedValueOnce({ defaultId: "main", agents: [] });
    request.mockResolvedValueOnce(savedAgent(originalId));
    await expect(agents.create("New agent", started)).resolves.toMatchObject({
      agentId: originalId,
    });
    expect(request.mock.calls.filter(([method]) => method === "agents.create")).toHaveLength(1);
  });
});
