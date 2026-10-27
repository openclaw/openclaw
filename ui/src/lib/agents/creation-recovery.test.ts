import { describe, expect, it, onTestFinished, vi } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.js";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import { createGatewayHarness } from "../config/config-test-harness.ts";
import { agentCreationRejection } from "./creation.test-support.ts";
import { createAgentCapability } from "./index.ts";

async function fixture() {
  const roster = { defaultId: "main", agents: [{ id: "main", name: "Existing agent" }] };
  const request = vi.fn<(method: string, params?: unknown) => Promise<unknown>>();
  request.mockResolvedValueOnce(roster);
  // SAFETY: Only the request and immutable Gateway target are consumed by this capability.
  const client = { request, gatewayUrl: "ws://original.test" } as unknown as GatewayBrowserClient;
  const harness = createGatewayHarness(client);
  const agents = createAgentCapability(harness.gateway);
  const started = vi.fn<(agentId: string) => void>();
  const create = () => agents.create("New agent", started);
  onTestFinished(() => agents.dispose());
  await agents.ensureList();
  return { agents, request, harness, roster, started, create };
}

function createdAgent(agentId: string) {
  return {
    agentId,
    name: "New agent",
    onboarding: { status: "completed", sessionKey: `agent:${agentId}:main` },
  };
}
const createResponse = async (_method: string, params?: unknown) =>
  createdAgent((params as { agentId: string }).agentId);

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
    const { agents, request, harness, roster } = await fixture();
    const original = agents.create("New agent");
    const unsentId = agents.state.pendingAgent!.id;
    harness.publish(false);
    await expect(original).resolves.toBeNull();
    expect(request).toHaveBeenCalledOnce();

    request.mockResolvedValueOnce(roster);
    harness.publish(true);
    request.mockImplementationOnce(createResponse);
    const result = await agents.create("New agent");
    expect(result!.agentId).not.toBe(unsentId);
  });

  it("does not let an old receipt finish a newer recovery of the same agent", async () => {
    const { agents, request, harness } = await fixture();
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
    request.mockResolvedValueOnce({ defaultId: "main", agents: [] });
    harness.publish(true);
    request.mockReturnValueOnce(recoveryRead.promise);
    const recovery = agents.create("New agent");
    await vi.waitFor(() => expect(request).toHaveBeenCalledWith("config.get", {}));
    oldResponse.resolve(createdAgent(agentId));
    await expect(original).resolves.toBeNull();
    expect(agents.state.pendingAgent).toMatchObject({ id: agentId });
    recoveryRead.resolve(savedAgent(agentId));
    await expect(recovery).resolves.toMatchObject({ agentId });
    expect(agents.state.pendingAgent).toBeUndefined();
    expect(request.mock.calls.filter(([method]) => method === "agents.create")).toHaveLength(1);
  });

  it("recovers a saved agent after a rejected response without claiming its greeting completed", async () => {
    const { agents, create, request, roster, started } = await fixture();
    request.mockRejectedValueOnce(agentCreationRejection("Saved but application unconfirmed"));
    request.mockImplementationOnce(async () => savedAgent(started.mock.calls[0]![0]));
    const result = await create();
    const attemptedId = started.mock.calls[0]![0];
    expect(result).toMatchObject({
      agentId: attemptedId,
      name: "Recovered name",
      onboarding: { sessionKey: `agent:${attemptedId}:home`, status: "error" },
    });
    expect(agents.state.agentsList?.agents).toEqual([
      { id: attemptedId, name: "Recovered name" },
      ...roster.agents,
    ]);
  });

  it("retains an uncertain attempt across reconnect and checks it on retry instead of creating a duplicate", async () => {
    const { create, request, harness, started } = await fixture();
    request.mockRejectedValueOnce(new Error("Response lost"));
    request.mockResolvedValueOnce(absentAgent);
    await expect(create()).rejects.toThrow("hasn't confirmed");
    const attemptedId = started.mock.calls[0]![0];
    harness.publish(false);
    request.mockResolvedValueOnce({ defaultId: "main", agents: [] });
    harness.publish(true);
    request.mockRejectedValueOnce(new Error("Read unavailable"));
    await expect(create()).rejects.toThrow("hasn't confirmed");
    request.mockResolvedValueOnce(savedAgent(attemptedId));
    await expect(create()).resolves.toHaveProperty("agentId", attemptedId);
    expect(started.mock.calls).toEqual([[attemptedId], [attemptedId], [attemptedId]]);
    expect(request.mock.calls.filter(([method]) => method === "agents.create")).toHaveLength(1);
  });

  it("permits a fresh identity after a correlated rejection and authoritative absence", async () => {
    const { create, request, started } = await fixture();
    request.mockRejectedValueOnce(agentCreationRejection("Inference unavailable"));
    request.mockResolvedValueOnce(absentAgent);
    await expect(create()).rejects.toThrow("Inference unavailable");
    request.mockImplementationOnce(createResponse);
    await create();
    expect(started.mock.calls[1]![0]).not.toBe(started.mock.calls[0]![0]);
    expect(request.mock.calls.filter(([method]) => method === "agents.create")).toHaveLength(2);
  });

  it("never reconciles an original Gateway's uncertain write against a different Gateway", async () => {
    const { create, request, harness, started } = await fixture();
    request.mockRejectedValueOnce(new Error("Response lost"));
    request.mockResolvedValueOnce(absentAgent);
    await expect(create()).rejects.toThrow("hasn't confirmed");
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
    await expect(create()).rejects.toThrow("hasn't confirmed");
    expect(started.mock.calls[1]![0]).not.toBe(originalId);
    expect(otherRequest).not.toHaveBeenCalledWith(
      "agents.create",
      expect.objectContaining({ agentId: originalId }),
    );
    request.mockResolvedValueOnce({ defaultId: "main", agents: [] });
    harness.publish(true);
    request.mockResolvedValueOnce(savedAgent(originalId));
    await expect(create()).resolves.toHaveProperty("agentId", originalId);
    expect(request.mock.calls.filter(([method]) => method === "agents.create")).toHaveLength(1);
  });
});
