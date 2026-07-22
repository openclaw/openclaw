import { beforeEach, describe, expect, it, vi } from "vitest";
import type { GatewayRequestHandlers } from "./types.js";

const spawnSubagentDirectMock = vi.hoisted(() =>
  vi.fn(async () => ({
    status: "accepted",
    childSessionKey: "agent:ai-engineer:subagent:real-child",
    runId: "run-real-child",
    mode: "run",
  })),
);

vi.mock("../../agents/subagent-spawn.js", () => ({
  spawnSubagentDirect: spawnSubagentDirectMock,
}));

type RespondCall = [boolean, unknown?, { code: number; message: string }?];

let agenticOsRuntimeContractHandlers: GatewayRequestHandlers;

const acquireParams = {
  client_lease_id: "lease-a",
  idempotency_key: "lease-idem-a",
  run_id: "run-a",
  phase: "phase-b",
  transition_id: "transition-a",
  agent_id: "ai-engineer",
  requester_agent_id: "main",
  ttl_ms: 60_000,
};

const sessionMetadata = {
  run_id: "run-a",
  transition_id: "transition-a",
  client_request_id: "spawn-a",
  idempotency_key: "spawn-idem-a",
  phase: "phase-b",
  agent_id: "ai-engineer",
  task_digest: "sha256:test",
};

async function invoke(method: string, params: Record<string, unknown> = {}) {
  const respond = vi.fn();
  const handler = agenticOsRuntimeContractHandlers[method];
  if (!handler) {
    throw new Error(`missing handler: ${method}`);
  }
  await handler({
    params,
    respond: respond as never,
    context: {} as never,
    client: null,
    req: { type: "req", id: "req-1", method },
    isWebchatConnect: () => false,
  });
  const call = respond.mock.calls[0] as RespondCall | undefined;
  if (!call) {
    throw new Error(`missing response for ${method}`);
  }
  return call;
}

function payload(call: RespondCall): Record<string, unknown> {
  expect(call[0]).toBe(true);
  return call[1] as Record<string, unknown>;
}

function expectInvalid(call: RespondCall, message: string) {
  expect(call[0]).toBe(false);
  expect(call[2]?.message).toContain(message);
}

async function acquireLease(params: Record<string, unknown> = acquireParams) {
  const response = payload(await invoke("subagents.allowLease.acquire", params));
  expect(response.gateway_lease_id).toEqual(expect.stringContaining("gateway-lease:"));
  return response.gateway_lease_id as string;
}

describe("Agentic OS runtime contract v1", () => {
  beforeEach(async () => {
    vi.resetModules();
    ({ agenticOsRuntimeContractHandlers } = await import("./agentic-os-runtime-contract.js"));
    spawnSubagentDirectMock.mockClear();
    spawnSubagentDirectMock.mockResolvedValue({
      status: "accepted",
      childSessionKey: "agent:ai-engineer:subagent:real-child",
      runId: "run-real-child",
      mode: "run",
    });
  });

  it("replays duplicate allow lease acquire and rejects conflicting reuse", async () => {
    const gatewayLeaseId = await acquireLease();
    const duplicate = payload(await invoke("subagents.allowLease.acquire", acquireParams));
    expect(duplicate.gateway_lease_id).toBe(gatewayLeaseId);

    expectInvalid(
      await invoke("subagents.allowLease.acquire", { ...acquireParams, ttl_ms: 30_000 }),
      "conflicting allow lease acquire idempotency_key",
    );
    expectInvalid(
      await invoke("subagents.allowLease.acquire", {
        ...acquireParams,
        idempotency_key: "lease-idem-b",
      }),
      "conflicting allow lease client_lease_id",
    );
  });

  it("rejects owner-mismatched release and replays exact release with a release idempotency key", async () => {
    const gatewayLeaseId = await acquireLease();
    expectInvalid(
      await invoke("subagents.allowLease.release", {
        ...acquireParams,
        idempotency_key: "lease-release-idem-a",
        requester_agent_id: "other",
        gateway_lease_id: gatewayLeaseId,
      }),
      "allow lease owner mismatch",
    );

    const releaseParams = {
      ...acquireParams,
      idempotency_key: "lease-release-idem-a",
      gateway_lease_id: gatewayLeaseId,
    };
    const released = payload(await invoke("subagents.allowLease.release", releaseParams));
    expect(released.gateway_lease_id).toBe(gatewayLeaseId);
    expect(released.released).toBe(true);
    const replayed = payload(await invoke("subagents.allowLease.release", releaseParams));
    expect(replayed).toEqual(released);
  });

  it("replays duplicate sessions_spawn and rejects conflicting reuse", async () => {
    const gatewayLeaseId = await acquireLease();
    const spawnParams = {
      task: "verify metadata contract",
      taskName: "verify-contract",
      runtime: "subagent",
      mode: "run",
      agentId: "ai-engineer",
      gateway_lease_id: gatewayLeaseId,
      client_request_id: "spawn-a",
      idempotency_key: "spawn-idem-a",
      metadata: sessionMetadata,
    };
    const accepted = payload(await invoke("sessions_spawn", spawnParams));
    expect(accepted.status).toBe("accepted");
    expect(accepted.session_key).toBe("agent:ai-engineer:subagent:real-child");
    expect(spawnSubagentDirectMock).toHaveBeenCalledTimes(1);
    const replayed = payload(await invoke("sessions_spawn", spawnParams));
    expect(replayed.session_key).toBe(accepted.session_key);
    expect(spawnSubagentDirectMock).toHaveBeenCalledTimes(1);

    expectInvalid(
      await invoke("sessions_spawn", { ...spawnParams, task: "different task" }),
      "conflicting sessions_spawn idempotency_key",
    );
  });

  it("routes legacy sessions_spawn callers through the real subagent runner", async () => {
    const accepted = payload(
      await invoke("sessions_spawn", {
        task: "legacy spawn",
        runtime: "subagent",
        agentId: "ai-engineer",
        mode: "run",
      }),
    );
    expect(accepted.status).toBe("accepted");
    expect(spawnSubagentDirectMock).toHaveBeenCalledWith(
      expect.objectContaining({ task: "legacy spawn", agentId: "ai-engineer" }),
      {},
    );
  });

  it("rejects released, expired, and wrong-owner leases before spawning", async () => {
    const gatewayLeaseId = await acquireLease();
    await invoke("subagents.allowLease.release", {
      ...acquireParams,
      idempotency_key: "lease-release-idem-a",
      gateway_lease_id: gatewayLeaseId,
    });
    const spawnParams = {
      task: "verify metadata contract",
      runtime: "subagent",
      agentId: "ai-engineer",
      gateway_lease_id: gatewayLeaseId,
      client_request_id: "spawn-a",
      idempotency_key: "spawn-idem-a",
      metadata: sessionMetadata,
    };
    expectInvalid(await invoke("sessions_spawn", spawnParams), "gateway_lease_id is not active");

    const shortLeaseId = await acquireLease({
      ...acquireParams,
      client_lease_id: "lease-expiring",
      idempotency_key: "lease-expiring-idem",
      ttl_ms: 1,
    });
    const future = Date.now() + 10_000;
    vi.spyOn(Date, "now").mockReturnValue(future);
    try {
      expectInvalid(
        await invoke("sessions_spawn", { ...spawnParams, gateway_lease_id: shortLeaseId }),
        "gateway_lease_id is not active",
      );
    } finally {
      vi.restoreAllMocks();
    }

    const otherOwnerLeaseId = await acquireLease({
      ...acquireParams,
      client_lease_id: "lease-other-owner",
      idempotency_key: "lease-other-owner-idem",
      agent_id: "other-agent",
    });
    expectInvalid(
      await invoke("sessions_spawn", { ...spawnParams, gateway_lease_id: otherOwnerLeaseId }),
      "gateway_lease_id owner does not authorize spawn: agent_id",
    );
  });

  it("projects accepted session identity and metadata through list, status, and history", async () => {
    const gatewayLeaseId = await acquireLease();
    const accepted = payload(
      await invoke("sessions_spawn", {
        task: "verify metadata contract",
        runtime: "subagent",
        agentId: "ai-engineer",
        gateway_lease_id: gatewayLeaseId,
        client_request_id: "spawn-a",
        idempotency_key: "spawn-idem-a",
        metadata: sessionMetadata,
      }),
    );
    const sessionKey = accepted.session_key as string;

    const listed = payload(await invoke("sessions_list"));
    expect(listed.sessions).toEqual(
      expect.arrayContaining([expect.objectContaining({ session_key: sessionKey })]),
    );

    const status = payload(await invoke("sessions_status", { session_key: sessionKey }));
    const history = payload(
      await invoke("sessions_history", { sessionKey, limit: 5, includeTools: true }),
    );
    for (const projection of [accepted, status, history]) {
      expect(projection.external_id).toBe(sessionKey);
      expect(projection.spawn_request_session_key).toBe(sessionKey);
      expect(projection.metadata).toMatchObject({
        metadata_contract_version: "v1",
        normalized: sessionMetadata,
      });
      expect(projection.session).toMatchObject({
        session_key: sessionKey,
        metadata: expect.objectContaining({ normalized: sessionMetadata }),
      });
    }
    expect(history.messages).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          session_key: sessionKey,
          metadata: expect.objectContaining({ normalized: sessionMetadata }),
        }),
      ]),
    );
  });
});
