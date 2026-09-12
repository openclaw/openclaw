import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  durable: undefined as
    | {
        owner: { agentId: string; sessionKey?: string; sessionId?: string };
        terminal: { status: "ok" | "error" | "timeout" };
      }
    | undefined,
  target: null as {
    storeKey: string;
    entry: { sessionId?: string; createdActor?: Record<string, unknown> };
  } | null,
  visible: true,
  waitResult: { runId: "run-recovered", status: "ok" as const },
}));

vi.mock("../../infra/agent-run-registry.js", () => ({
  getAgentRunContext: () => undefined,
}));
vi.mock("../agent-turn/agent-job.js", () => ({
  readDurableAgentJobTerminalReceipt: () => state.durable,
}));
vi.mock("../agent-turn/agent-turn-service.js", () => ({
  createAgentTurnService: () => ({ waitForTurn: async () => state.waitResult }),
}));
vi.mock("../operator-role-policy.js", () => ({
  operatorSessionCap: () => "none",
}));
vi.mock("../session-sharing.js", () => ({
  isGatewayAdmin: () => false,
  resolveSessionSharingTarget: () => state.target,
  createSessionListEntryFilter: () => () => state.visible,
}));

const { agentWaitHandler } = await import("./agent-wait.js");

function caller() {
  return {
    authenticatedUserProfile: { profileId: "profile-owner" },
    connect: { scopes: ["operator.read"] },
  };
}

async function wait() {
  const respond = vi.fn();
  await agentWaitHandler({
    params: { runId: "run-recovered", timeoutMs: 0 },
    respond,
    context: { getRuntimeConfig: () => ({}) },
    req: {},
    client: caller(),
    isWebchatConnect: () => false,
  } as never);
  return respond;
}

describe("agent.wait recovered receipt authorization", () => {
  beforeEach(() => {
    state.durable = {
      owner: {
        agentId: "main",
        sessionKey: "agent:main:owned",
        sessionId: "session-owned",
      },
      terminal: { status: "ok" },
    };
    state.target = {
      storeKey: "agent:main:owned",
      entry: {
        sessionId: "session-owned",
        createdActor: { type: "human", source: "profile", id: "profile-owner" },
      },
    };
    state.visible = true;
  });

  it("allows a still-authorized caller to wait after process-local run state is lost", async () => {
    const respond = await wait();
    expect(respond).toHaveBeenCalledWith(true, state.waitResult);
  });

  it("rejects an unrelated caller without exposing the recovered receipt", async () => {
    state.visible = false;
    const respond = await wait();
    expect(respond).toHaveBeenCalledWith(
      false,
      undefined,
      expect.objectContaining({ code: "INVALID_REQUEST", message: "agent run was not found" }),
    );
  });

  it("rejects a recovered owner after its retained session key is reused", async () => {
    state.target = {
      storeKey: "agent:main:owned",
      entry: { sessionId: "session-replacement" },
    };
    const respond = await wait();
    expect(respond).toHaveBeenCalledWith(
      false,
      undefined,
      expect.objectContaining({ code: "INVALID_REQUEST", message: "agent run was not found" }),
    );
  });
});
