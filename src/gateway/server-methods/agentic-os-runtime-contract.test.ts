import { beforeEach, describe, expect, it, vi } from "vitest";
import type { GatewayRequestHandlers } from "./types.js";

const spawnSubagentDirectMock = vi.hoisted(() =>
  vi.fn(async (_params?: { task?: string }) => ({
    status: "accepted",
    childSessionKey: "agent:ai-engineer:subagent:real-child",
    runId: "run-real-child",
    mode: "run",
  })),
);
const waitForAgentJobMock = vi.hoisted(() => vi.fn(async () => null));
const findTaskByRunIdForStatusMock = vi.hoisted(() =>
  vi.fn((): { status: string; startedAt?: number; endedAt?: number } | undefined => ({
    status: "running",
    startedAt: 5,
  })),
);

vi.mock("../../agents/subagent-spawn.js", () => ({
  spawnSubagentDirect: spawnSubagentDirectMock,
}));
vi.mock("./agent-job.js", () => ({ waitForAgentJob: waitForAgentJobMock }));
vi.mock("../../tasks/task-status-access.js", () => ({
  findTaskByRunIdForStatus: findTaskByRunIdForStatusMock,
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

async function invoke(method: string, params: Record<string, unknown> = {}, deviceId?: string) {
  const respond = vi.fn();
  const handler = agenticOsRuntimeContractHandlers[method];
  if (!handler) {
    throw new Error(`missing handler: ${method}`);
  }
  await handler({
    params,
    respond: respond as never,
    context: {
      getRuntimeConfig: () => ({
        agents: { list: [{ id: "main" }, { id: "ai-engineer" }] },
      }),
      loadGatewayModelCatalog: async () => [],
      loadGatewayModelCatalogSnapshot: async () => ({ entries: [] }),
      logGateway: { debug: () => {}, error: () => {}, warn: () => {} },
    } as never,
    client: deviceId ? ({ connect: { device: { id: deviceId } } } as never) : null,
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
    waitForAgentJobMock.mockReset();
    waitForAgentJobMock.mockResolvedValue(null);
    findTaskByRunIdForStatusMock.mockReset();
    findTaskByRunIdForStatusMock.mockReturnValue({ status: "running", startedAt: 5 });
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

  it("isolates lease and session projections by authenticated principal", async () => {
    const gatewayLeaseId = payload(
      await invoke("subagents.allowLease.acquire", acquireParams, "device-a"),
    ).gateway_lease_id as string;
    expect(payload(await invoke("subagents.allowLease.status", {}, "device-b")).leases).toEqual([]);
    expectInvalid(
      await invoke(
        "sessions_spawn",
        {
          task: "principal isolation",
          runtime: "subagent",
          agentId: "ai-engineer",
          gateway_lease_id: gatewayLeaseId,
          client_request_id: "spawn-a",
          idempotency_key: "spawn-idem-a",
          metadata: sessionMetadata,
        },
        "device-b",
      ),
      "different authenticated principal",
    );
  });

  it("prunes expired lease replay identities after bounded retention", async () => {
    await acquireLease({ ...acquireParams, ttl_ms: 1 });
    vi.spyOn(Date, "now").mockReturnValue(Date.now() + 10 * 60 * 1000);
    try {
      const reacquired = payload(
        await invoke("subagents.allowLease.acquire", { ...acquireParams, ttl_ms: 60_000 }),
      );
      expect(reacquired.status).toBe("active");
    } finally {
      vi.restoreAllMocks();
    }
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
      "requester_agent_id does not match authenticated requester",
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

  it("rejects unleased legacy sessions_spawn callers before the runner", async () => {
    expectInvalid(
      await invoke("sessions_spawn", {
        task: "legacy spawn",
        runtime: "subagent",
        agentId: "ai-engineer",
        mode: "run",
      }),
      "missing required string: client_request_id",
    );
    expect(spawnSubagentDirectMock).not.toHaveBeenCalled();
  });

  it("coalesces concurrent duplicate sessions_spawn calls onto one child runner", async () => {
    const gatewayLeaseId = await acquireLease();
    let resolveSpawn!: (value: Record<string, unknown>) => void;
    spawnSubagentDirectMock.mockReturnValueOnce(
      new Promise((resolve) => {
        resolveSpawn = resolve;
      }),
    );
    const spawnParams = {
      task: "concurrent duplicate",
      runtime: "subagent",
      agentId: "ai-engineer",
      gateway_lease_id: gatewayLeaseId,
      client_request_id: "spawn-a",
      idempotency_key: "spawn-idem-a",
      metadata: sessionMetadata,
    };
    const first = invoke("sessions_spawn", spawnParams);
    const second = invoke("sessions_spawn", spawnParams);
    await vi.waitFor(() => expect(spawnSubagentDirectMock).toHaveBeenCalledTimes(1));
    resolveSpawn({
      status: "accepted",
      childSessionKey: "agent:ai-engineer:subagent:real-child",
      runId: "run-real-child",
    });
    expect(payload(await first).session_key).toBe(payload(await second).session_key);
    expect(spawnSubagentDirectMock).toHaveBeenCalledTimes(1);
  });

  it("caps distinct slow pending spawns atomically and fails the overflow request closed", async () => {
    const gatewayLeaseId = await acquireLease();
    let releasePending!: () => void;
    const pendingGate = new Promise<void>((resolve) => {
      releasePending = resolve;
    });
    spawnSubagentDirectMock.mockImplementation(async (request) => {
      await pendingGate;
      const suffix = request?.task?.replace(/\D/g, "") || "unknown";
      return {
        status: "accepted",
        childSessionKey: `agent:ai-engineer:subagent:bounded-${suffix}`,
        runId: `run-bounded-${suffix}`,
        mode: "run",
      };
    });
    const makeSpawnParams = (index: number) => ({
      task: `bounded pending ${index}`,
      runtime: "subagent",
      agentId: "ai-engineer",
      gateway_lease_id: gatewayLeaseId,
      client_request_id: `spawn-pending-${index}`,
      idempotency_key: `spawn-pending-idem-${index}`,
      metadata: {
        ...sessionMetadata,
        client_request_id: `spawn-pending-${index}`,
        idempotency_key: `spawn-pending-idem-${index}`,
        task_digest: `sha256:pending-${index}`,
      },
    });

    const pending = Array.from({ length: 1_024 }, (_, index) =>
      invoke("sessions_spawn", makeSpawnParams(index)),
    );
    await vi.waitFor(() => expect(spawnSubagentDirectMock).toHaveBeenCalledTimes(1_024), {
      timeout: 10_000,
    });
    expectInvalid(
      await invoke("sessions_spawn", makeSpawnParams(1_024)),
      "pending session spawn capacity reached",
    );
    expect(spawnSubagentDirectMock).toHaveBeenCalledTimes(1_024);

    releasePending();
    const completed = await Promise.all(pending);
    expect(completed.every((call) => call[0] === true)).toBe(true);
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
    if (status.runtime_session !== null) {
      expect(status.runtime_session).toMatchObject({
        key: sessionKey,
        observed: expect.any(Boolean),
        message_count: expect.any(Number),
        lifecycle_status: "running",
        runtime_status: "running",
        terminal: false,
      });
    }
    expect(history.messages).toEqual([]);
    expect(history).not.toHaveProperty("task");
  });

  it("projects canonical failed child lifecycle without exposing raw failure text", async () => {
    const gatewayLeaseId = await acquireLease();
    const accepted = payload(
      await invoke("sessions_spawn", {
        task: "verify failure lifecycle",
        runtime: "subagent",
        agentId: "ai-engineer",
        gateway_lease_id: gatewayLeaseId,
        client_request_id: "spawn-failure",
        idempotency_key: "spawn-failure-idem",
        metadata: {
          ...sessionMetadata,
          client_request_id: "spawn-failure",
          idempotency_key: "spawn-failure-idem",
        },
      }),
    );
    waitForAgentJobMock.mockResolvedValue({
      status: "error",
      startedAt: 10,
      endedAt: 20,
      error: "private provider failure",
    });
    const status = payload(
      await invoke("sessions_status", { session_key: accepted.session_key as string }),
    );
    expect(status.runtime_session).toMatchObject({
      lifecycle_status: "failed",
      runtime_status: "error",
      terminal: true,
      started_at_ms: 10,
      ended_at_ms: 20,
    });
    expect(JSON.stringify(status.runtime_session)).not.toContain("private provider failure");
  });

  it("prunes aged session projections after bounded retention", async () => {
    const gatewayLeaseId = await acquireLease();
    const accepted = payload(
      await invoke("sessions_spawn", {
        task: "verify bounded session retention",
        runtime: "subagent",
        agentId: "ai-engineer",
        gateway_lease_id: gatewayLeaseId,
        client_request_id: "spawn-retention",
        idempotency_key: "spawn-retention-idem",
        metadata: {
          ...sessionMetadata,
          client_request_id: "spawn-retention",
          idempotency_key: "spawn-retention-idem",
        },
      }),
    );
    const sessionKey = accepted.session_key as string;
    const initial = payload(await invoke("sessions_list"));
    expect(initial.sessions).toEqual(
      expect.arrayContaining([expect.objectContaining({ session_key: sessionKey })]),
    );

    vi.spyOn(Date, "now").mockReturnValue(Date.now() + 25 * 60 * 60 * 1000);
    try {
      expect(payload(await invoke("sessions_list")).sessions).toEqual([]);
      expectInvalid(
        await invoke("sessions_status", { session_key: sessionKey }),
        "unknown session_key",
      );
    } finally {
      vi.restoreAllMocks();
    }
  });
});
