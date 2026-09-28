import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  SessionFollowupCompletion,
  withFollowupRequest,
  withFollowupSuccessor,
} from "../../agents/subagents/completion/session-followup-completion.js";
import type { FollowupRequest } from "../../agents/subagents/completion/session-followup-completion.types.js";
import type { SubagentRunRecord } from "../../agents/subagents/registry/subagent-registry.types.js";
import { bindInProcessSubagentResume } from "../in-process-subagent-resume.js";
import { prepareGatewaySubagentRun } from "./agent-run-subagent.js";
import type { AgentTurnPrincipal } from "./types.js";

const mocks = vi.hoisted(() => ({
  registerSubagentRun: vi.fn(),
  adoptPausedSubagentRunForFollowUp: vi.fn(),
  getLatestLiveSubagentRunByChildSessionKey: vi.fn(),
  prepareParentSubagentResume: vi.fn(),
}));
vi.mock("../../agents/subagents/registry/subagent-registry-read.js", () => ({
  getLatestLiveSubagentRunByChildSessionKey: mocks.getLatestLiveSubagentRunByChildSessionKey,
}));
vi.mock("../../agents/subagents/registry/subagent-registry.js", () => ({
  registerSubagentRun: mocks.registerSubagentRun,
  adoptPausedSubagentRunForFollowUp: mocks.adoptPausedSubagentRunForFollowUp,
}));
vi.mock("../../config/sessions.js", () => ({
  resolveAgentIdFromSessionKey: () => "main",
  resolveAgentMainSessionKey: () => "agent:main:main",
}));
vi.mock("../session-subagent-resume.js", () => ({
  prepareParentSubagentResume: mocks.prepareParentSubagentResume,
}));

const childSessionKey = "agent:main:subagent:child";
const runId = "child-run";
function pluginClient(): AgentTurnPrincipal {
  return {
    connect: {
      minProtocol: 1,
      maxProtocol: 1,
      client: { id: "gateway-client", version: "test", platform: "test", mode: "backend" },
    },
    internal: { agentRunTracking: "plugin_subagent", pluginRuntimeOwnerId: "example" },
  };
}
function parameters(
  overrides: Partial<Parameters<typeof prepareGatewaySubagentRun>[0]> = {},
): Parameters<typeof prepareGatewaySubagentRun>[0] {
  return {
    cfg: {},
    client: null,
    resolvedSessionKey: childSessionKey,
    request: { message: "Continue the child" },
    isOneShotModelRun: false,
    runId,
    getAdmittedSessionId: () => "child-session",
    assertResumeAdmissionCurrent: vi.fn(),
    context: { logGateway: { warn: vi.fn() } },
    ...overrides,
  };
}

function followupRequest(): FollowupRequest {
  return {
    runId,
    requesterSessionKey: "agent:main:main",
    requesterSessionId: "requester-session",
    requesterAgentId: "main",
    targetSessionKey: childSessionKey,
    targetAgentId: "main",
    custody: {
      signal: new AbortController().signal,
      assertCurrent: () => {},
      release: vi.fn(),
      run: (work) => work(),
    },
  };
}

describe("Gateway native subagent admission", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mocks.adoptPausedSubagentRunForFollowUp.mockReturnValue(false);
  });

  it("registers plugin work with its execution owner before accepting it", async () => {
    const params = parameters({ client: pluginClient() });
    await expect(prepareGatewaySubagentRun(params)).resolves.toEqual({
      pluginSubagent: true,
      reactivateSubagent: false,
    });
    expect(mocks.registerSubagentRun).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        runId,
        childSessionKey,
        task: "Continue the child",
        requesterSessionKey: "agent:main:main",
      }),
      { assertCurrent: params.assertResumeAdmissionCurrent },
    );
  });

  it("does not register work after its admission closes during runtime loading", async () => {
    let admitted = true;
    const preparation = prepareGatewaySubagentRun(
      parameters({
        client: pluginClient(),
        assertResumeAdmissionCurrent: () => {
          if (!admitted) {
            throw new Error("admission retired");
          }
        },
      }),
    );
    admitted = false;
    await expect(preparation).rejects.toThrow("admission retired");
    expect(mocks.registerSubagentRun).not.toHaveBeenCalled();
    expect(mocks.adoptPausedSubagentRunForFollowUp).not.toHaveBeenCalled();
  });

  it("preserves an explicit parent resume without creating a sibling owner", async () => {
    const client = pluginClient();
    const resume = {
      caller: { agentId: "main", sessionKey: "agent:main:main" },
      childSessionKey,
      childSessionId: "child-session",
      previousRunId: "previous-run",
      taskRunId: "canonical-run",
      generation: 1,
      createdAt: 1,
    };
    client.internal = bindInProcessSubagentResume({}, resume);
    const adoptParentResume = vi.fn(() => "previous-run");
    mocks.prepareParentSubagentResume.mockResolvedValue(adoptParentResume);
    await expect(prepareGatewaySubagentRun(parameters({ client }))).resolves.toEqual({
      pluginSubagent: false,
      reactivateSubagent: false,
      adoptParentResume,
    });
    expect(adoptParentResume).not.toHaveBeenCalled();
    expect(mocks.registerSubagentRun).not.toHaveBeenCalled();
  });

  it("does not let inter-session delivery reactivate a completed child", async () => {
    const result = await prepareGatewaySubagentRun(
      parameters({
        inputProvenance: {
          kind: "inter_session",
          sourceSessionKey: "agent:main:main",
          sourceTool: "sessions_send",
        },
      }),
    );
    expect(result).toEqual({ pluginSubagent: false, reactivateSubagent: false });
    expect(mocks.registerSubagentRun).not.toHaveBeenCalled();
    await expect(prepareGatewaySubagentRun(parameters())).resolves.toEqual({
      pluginSubagent: false,
      reactivateSubagent: true,
    });
  });

  it.each([true, false])(
    "binds result custody only to its original requester (matching: %s)",
    async (matching) => {
      const request = followupRequest();
      try {
        const preparation = withFollowupRequest(request, () =>
          prepareGatewaySubagentRun(
            parameters({
              inputProvenance: {
                kind: "inter_session",
                sourceTool: "sessions_send",
                sourceSessionKey: matching ? request.requesterSessionKey : "agent:main:other",
              },
            }),
          ),
        );
        if (matching) {
          const prepared = await preparation;
          expect(prepared).toEqual({
            pluginSubagent: false,
            reactivateSubagent: false,
            followupCompletion: request.completion,
          });
          expect(request.completion?.ownsExecution(runId)).toBe(true);
          expect(request.completion?.accepted).toBe(false);
        } else {
          await expect(preparation).rejects.toThrow("requester does not match");
          expect(request.completion).toBeUndefined();
        }
        expect(mocks.registerSubagentRun).not.toHaveBeenCalled();
        expect(mocks.prepareParentSubagentResume).not.toHaveBeenCalled();
      } finally {
        request.completion?.close();
      }
    },
  );

  it("prepares a follow-up successor without adopting its paused predecessor", async () => {
    const owner = SessionFollowupCompletion.bind(followupRequest());
    owner.markAccepted(runId);
    const child: SubagentRunRecord = {
      runId: "nested-child",
      childSessionKey: "agent:main:subagent:nested",
      requesterSessionKey: childSessionKey,
      requesterDisplayKey: childSessionKey,
      task: "Nested work",
      cleanup: "keep",
      createdAt: 1,
      execution: { status: "terminal", endedAt: 2, outcome: { status: "ok" } },
      requesterSettleWake: {
        status: "pending",
        attemptCount: 0,
        requesterYieldBatch: true,
        rearmGeneration: 1,
        batchRunIds: ["nested-child"],
      },
    };
    try {
      owner.promoteYield(runId, [child], 1);
      await owner.settle(runId, { status: "ok", yielded: true });
      owner.finishExecution(runId);
      const successor = owner.successor([child], "resumed-run", () => {});
      const prepared = await withFollowupSuccessor(successor, () =>
        prepareGatewaySubagentRun(parameters({ runId: "resumed-run" })),
      );
      expect(prepared).toEqual({
        pluginSubagent: false,
        reactivateSubagent: false,
        followupCompletion: owner,
        followupSuccessor: successor,
      });
      expect(owner.ownsExecution(runId)).toBe(true);
      expect(owner.ownsExecution("resumed-run")).toBe(false);
      expect(mocks.registerSubagentRun).not.toHaveBeenCalled();
      expect(mocks.prepareParentSubagentResume).not.toHaveBeenCalled();
    } finally {
      owner.close();
    }
  });
});
