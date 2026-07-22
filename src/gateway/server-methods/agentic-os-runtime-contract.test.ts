import { beforeEach, describe, expect, it, vi } from "vitest";
import { __resetAgenticOsRuntimeContractForTests } from "../agentic-os-runtime-contract.js";
import { agenticOsRuntimeContractHandlers } from "./agentic-os-runtime-contract.js";

type RespondCall = [boolean, unknown?, { code: number; message: string }?];

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
  beforeEach(() => {
    __resetAgenticOsRuntimeContractForTests();
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

  it("rejects owner-mismatched release and replays exact release", async () => {
    const gatewayLeaseId = await acquireLease();
    expectInvalid(
      await invoke("subagents.allowLease.release", {
        ...acquireParams,
        requester_agent_id: "other",
        gateway_lease_id: gatewayLeaseId,
      }),
      "allow lease owner mismatch",
    );

    const releaseParams = { ...acquireParams, gateway_lease_id: gatewayLeaseId };
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
    expect(accepted.session_key).toEqual(expect.stringContaining("agent:ai-engineer:subagent:"));
    const replayed = payload(await invoke("sessions_spawn", spawnParams));
    expect(replayed.session_key).toBe(accepted.session_key);

    expectInvalid(
      await invoke("sessions_spawn", { ...spawnParams, task: "different task" }),
      "conflicting sessions_spawn idempotency_key",
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
