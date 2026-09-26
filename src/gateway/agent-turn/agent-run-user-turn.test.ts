import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SessionEntry } from "../../config/sessions.js";
import * as userTurnTranscript from "../../sessions/user-turn-transcript.js";
import type { AgentRunRequest } from "../server-methods/agent-request-types.js";
import type { GatewayClient } from "../server-methods/types.js";
import { prepareAgentRunUserTurn } from "./agent-run-user-turn.js";
import type { AgentTurnContext } from "./types.js";

const mocks = vi.hoisted(() => ({
  loadSessionEntry: vi.fn(),
  persistSessionTranscriptTurn: vi.fn(),
}));

vi.mock("../session-utils.js", async () => {
  const actual = await vi.importActual<typeof import("../session-utils.js")>("../session-utils.js");
  return { ...actual, loadSessionEntry: mocks.loadSessionEntry };
});

vi.mock("../../config/sessions/session-accessor.js", async () => {
  const actual = await vi.importActual<typeof import("../../config/sessions/session-accessor.js")>(
    "../../config/sessions/session-accessor.js",
  );
  return { ...actual, persistSessionTranscriptTurn: mocks.persistSessionTranscriptTurn };
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
  });

  it.each(["human", "agent", "unknown"] as const)(
    "keeps native run authority separate from %s transcript authorship",
    async (author) => {
      const createRecorder = userTurnTranscript.createUserTurnTranscriptRecorder;
      const spy = vi
        .spyOn(userTurnTranscript, "createUserTurnTranscriptRecorder")
        .mockImplementationOnce((options) => {
          const recorder = createRecorder(options);
          // This test owns admission composition; persistence is covered by the SQLite creation test.
          recorder.stageApproved = async () => true;
          return recorder;
        });
      const client: GatewayClient = {
        connect: {
          minProtocol: 1,
          maxProtocol: 1,
          client: { id: "cli", version: "test", platform: "test", mode: "cli" },
          scopes: ["operator.admin"],
        },
        authenticatedUserProfile: {
          profileId: "owner",
          displayName: "Owner",
          hasAvatar: false,
          updatedAt: 1,
        },
        ...(author === "human"
          ? {}
          : {
              internal: {
                syntheticClient: true,
                ...(author === "agent"
                  ? { agentToolCaller: { agentId: "worker", sessionKey: "agent:worker:parent" } }
                  : {}),
              },
            }),
      };
      try {
        const prepared = await prepareAgentRunUserTurn({
          assertCurrent: () => {},
          request: { message: "task", idempotencyKey: "task-run" },
          cfg: {},
          resolvedSessionKey: "agent:main:child",
          admittedSessionId: "child-id",
          activeSessionAgentId: "main",
          suppressVisibleSessionEffects: false,
          requestedPromptPersistenceSuppression: false,
          canUseInternalRuntimeHandoff: false,
          message: "task",
          effectiveTranscriptInputText: "task",
          images: [],
          offloadedRefs: [],
          runId: "task-run",
          client,
          context: { logGateway: { warn: vi.fn() } } as unknown as AgentTurnContext,
        });
        expect(prepared.senderIsOwner).toBe(true);
        expect(prepared.recorder?.message?.["__openclaw"]).toMatchObject({
          senderIsOwner: author === "human",
        });
        expect(prepared.recorder?.message?.["__openclaw"]?.senderIdentity).toEqual(
          author === "human"
            ? { type: "profile", id: "owner" }
            : author === "agent"
              ? { type: "agent", id: "worker" }
              : undefined,
        );
      } finally {
        spy.mockRestore();
      }
    },
  );

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
    expect(mocks.persistSessionTranscriptTurn).not.toHaveBeenCalled();
  });
});
