import { beforeEach, describe, expect, it, vi } from "vitest";
import { buildSubagentLaunchRequest } from "../../agents/subagents/spawn/subagent-spawn-launch-request.js";
import type { SessionEntry } from "../../config/sessions.js";
import type { AgentRunRequest } from "../server-methods/agent-request-types.js";
import { prepareAgentRunUserTurn } from "./agent-run-user-turn.js";
import type { AgentTurnContext } from "./types.js";

const mocks = vi.hoisted(() => ({
  loadSessionEntry: vi.fn(),
  persistSessionTranscriptTurn: vi.fn(),
  stageSessionPendingInput: vi.fn(),
}));

vi.mock("../session-utils.js", async () => {
  const actual = await vi.importActual<typeof import("../session-utils.js")>("../session-utils.js");
  return { ...actual, loadSessionEntry: mocks.loadSessionEntry };
});

vi.mock("../../config/sessions/session-accessor.js", async () => {
  const actual = await vi.importActual<typeof import("../../config/sessions/session-accessor.js")>(
    "../../config/sessions/session-accessor.js",
  );
  return {
    ...actual,
    persistSessionTranscriptTurn: mocks.persistSessionTranscriptTurn,
    stageSessionPendingInput: mocks.stageSessionPendingInput,
  };
});

describe("prepareAgentRunUserTurn", () => {
  beforeEach(() => {
    mocks.loadSessionEntry.mockReset();
    mocks.persistSessionTranscriptTurn.mockReset().mockImplementation(async (scope, options) => {
      const message = options.messages[0]?.message;
      return {
        appendedCount: 1,
        messages: [
          {
            appended: true,
            messageId: "stale-user-turn",
            message,
            anchor: {
              agentId: scope.agentId ?? "main",
              sessionId: scope.sessionId,
              sessionKey: scope.sessionKey,
              storePath: scope.storePath,
              generation: "test-generation",
              entryId: "stale-user-turn",
              rawSeq: 1,
              effectiveParentId: null,
              activeMessagePosition: 0,
            },
          },
        ],
        sessionEntry: scope.sessionEntry,
      };
    });
    mocks.stageSessionPendingInput.mockReset().mockImplementation(async (_target, options) => {
      const message = await options.prepareMessageAfterIdempotencyCheck(options.message);
      return {
        state: "staged",
        message,
        run: async (run: () => unknown) => await run(),
        finish: vi.fn(),
      };
    });
  });

  it("fails closed when the admitted session entry disappeared before transcript persistence", async () => {
    const sessionKey = "agent:main:main";
    const admittedSessionId = "admitted-session";
    const sessionEntry: SessionEntry = {
      sessionId: admittedSessionId,
      updatedAt: 1,
    };
    mocks.loadSessionEntry.mockReturnValue({
      cfg: {},
      storePath: "/tmp/sessions.json",
      canonicalKey: sessionKey,
      entry: undefined,
      store: {},
    });

    await expect(
      prepareAgentRunUserTurn({
        assertCurrent: () => {},
        request: {
          message: "must not reach the stale session",
          idempotencyKey: "disappeared-session-run",
        } as AgentRunRequest,
        cfg: {},
        sessionEntry,
        resolvedSessionKey: sessionKey,
        admittedSessionId,
        activeSessionAgentId: "main",
        suppressVisibleSessionEffects: false,
        requestedPromptPersistenceSuppression: false,
        canUseInternalRuntimeHandoff: false,
        message: "must not reach the stale session",
        effectiveTranscriptInputText: "must not reach the stale session",
        images: [],
        offloadedRefs: [],
        runId: "disappeared-session-run",
        client: null,
        context: {
          logGateway: { warn: vi.fn() },
        } as unknown as AgentTurnContext,
      }),
    ).rejects.toThrow("agent turn was not durably admitted");
    expect(mocks.stageSessionPendingInput).not.toHaveBeenCalled();
  });

  it("propagates sessions_spawn runtime authorship through admission and durable persistence", async () => {
    const sessionKey = "agent:worker:subagent:child";
    const admittedSessionId = "child-session";
    const sessionEntry: SessionEntry = { sessionId: admittedSessionId, updatedAt: 1 };
    const launch = buildSubagentLaunchRequest({
      completionMode: "announce",
      spawnMode: "run",
      message: "[Subagent Task]\nFix it",
      spawnedByKey: "agent:coordinator:dashboard:parent",
      toolSpawnMetadata: {},
      childSessionKey: sessionKey,
      childIdem: "spawn-agent-attribution",
      childSystemPrompt: "system",
      runTimeoutSeconds: 60,
      lightContext: false,
      swarmMaxConcurrent: 1,
    });
    mocks.loadSessionEntry.mockReturnValue({
      cfg: {},
      storePath: "/tmp/sessions.json",
      canonicalKey: sessionKey,
      entry: sessionEntry,
      store: { [sessionKey]: sessionEntry },
    });

    const prepared = await prepareAgentRunUserTurn({
      assertCurrent: () => {},
      request: launch.childLaunch.request as AgentRunRequest,
      cfg: { agents: { list: [{ id: "coordinator", identity: { name: "Coordinator" } }] } },
      sessionEntry,
      resolvedSessionKey: sessionKey,
      admittedSessionId,
      activeSessionAgentId: "worker",
      suppressVisibleSessionEffects: false,
      requestedPromptPersistenceSuppression: false,
      canUseInternalRuntimeHandoff: false,
      message: launch.childLaunch.request.message,
      effectiveTranscriptInputText: launch.childLaunch.request.message,
      images: [],
      offloadedRefs: [],
      inputProvenance: launch.childLaunch.request.inputProvenance,
      runId: "spawn-agent-attribution",
      client: {
        connect: { scopes: ["operator.admin"] },
        authenticatedUserProfile: { profileId: "owner", displayName: "Example User" },
        internal: {
          syntheticClient: true,
          agentRuntimeIdentity: {
            kind: "agentRuntime",
            agentId: "coordinator",
            sessionKey: "agent:coordinator:dashboard:parent",
          },
        },
      } as never,
      context: { logGateway: { warn: vi.fn() } } as unknown as AgentTurnContext,
    });

    expect(prepared.senderIsOwner).toBe(true);
    expect(mocks.stageSessionPendingInput).toHaveBeenCalledOnce();
    const persisted = prepared.recorder?.getPendingInputMessage();
    expect(persisted).toMatchObject({
      role: "user",
      content: "[Subagent Task]\nFix it",
      provenance: {
        kind: "internal_system",
        sourceSessionKey: "agent:coordinator:dashboard:parent",
        sourceTool: "sessions_spawn",
      },
      __openclaw: {
        senderId: "coordinator",
        senderName: "Coordinator",
        senderIdentity: { type: "agent", id: "coordinator" },
        senderIsOwner: false,
      },
    });
    expect(persisted?.__openclaw).not.toMatchObject({
      senderId: "owner",
      senderName: "Example User",
    });
  });

  it("keeps hidden synthetic spawn turns out of persistence", async () => {
    const prepared = await prepareAgentRunUserTurn({
      assertCurrent: () => {},
      request: { message: "hidden", idempotencyKey: "hidden-spawn" } as AgentRunRequest,
      cfg: {},
      admittedSessionId: "hidden-session",
      activeSessionAgentId: "worker",
      resolvedSessionKey: "agent:worker:subagent:hidden",
      suppressVisibleSessionEffects: true,
      requestedPromptPersistenceSuppression: false,
      canUseInternalRuntimeHandoff: false,
      message: "hidden",
      effectiveTranscriptInputText: "hidden",
      images: [],
      offloadedRefs: [],
      inputProvenance: { kind: "internal_system", sourceTool: "sessions_spawn" },
      runId: "hidden-spawn",
      client: {
        connect: { scopes: ["operator.admin"] },
        internal: {
          syntheticClient: true,
          agentRuntimeIdentity: {
            kind: "agentRuntime",
            agentId: "coordinator",
            sessionKey: "agent:coordinator:dashboard:parent",
          },
        },
      } as never,
      context: { logGateway: { warn: vi.fn() } } as unknown as AgentTurnContext,
    });

    expect(prepared.senderIsOwner).toBe(true);
    expect(prepared.recorder).toBeUndefined();
    expect(mocks.stageSessionPendingInput).not.toHaveBeenCalled();
  });
});
