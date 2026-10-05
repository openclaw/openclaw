import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SessionEntry } from "../../config/sessions.js";
import { prepareAgentRunUserTurn } from "./agent-run-user-turn.js";
import type { AgentTurnContext } from "./types.js";

const mocks = vi.hoisted(() => ({
  readSessionEntryReadOnlyInWorker: vi.fn(),
  persistSessionTranscriptTurn: vi.fn(),
  resolveSessionTranscriptRuntimeTarget: vi.fn(),
  stageSessionPendingInput: vi.fn(),
  persistInboundImagesForTranscript: vi.fn(),
  deleteMediaBuffer: vi.fn(),
  persistedMessages: [] as unknown[],
  beforeTranscriptCommit: undefined as (() => void) | undefined,
}));

vi.mock("../chat-attachments.js", async () => {
  const actual =
    await vi.importActual<typeof import("../chat-attachments.js")>("../chat-attachments.js");
  return { ...actual, persistInboundImagesForTranscript: mocks.persistInboundImagesForTranscript };
});

vi.mock("../../media/store.js", async () => {
  const actual =
    await vi.importActual<typeof import("../../media/store.js")>("../../media/store.js");
  return { ...actual, deleteMediaBuffer: mocks.deleteMediaBuffer };
});

vi.mock("../../config/sessions/session-entry-read-runtime.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../config/sessions/session-entry-read-runtime.js")>()),
  readSessionEntryReadOnlyInWorker: mocks.readSessionEntryReadOnlyInWorker,
}));

vi.mock("../../config/sessions/session-accessor.js", async () => {
  const actual = await vi.importActual<typeof import("../../config/sessions/session-accessor.js")>(
    "../../config/sessions/session-accessor.js",
  );
  return {
    ...actual,
    persistSessionTranscriptTurn: mocks.persistSessionTranscriptTurn,
    resolveSessionTranscriptRuntimeTarget: mocks.resolveSessionTranscriptRuntimeTarget,
    stageSessionPendingInput: mocks.stageSessionPendingInput,
  };
});

describe("prepareAgentRunUserTurn", () => {
  beforeEach(() => {
    mocks.readSessionEntryReadOnlyInWorker.mockReset();
    mocks.resolveSessionTranscriptRuntimeTarget.mockReset().mockResolvedValue({});
    mocks.persistInboundImagesForTranscript.mockReset().mockResolvedValue({ entries: [] });
    mocks.deleteMediaBuffer.mockReset().mockResolvedValue(undefined);
    mocks.persistedMessages.length = 0;
    mocks.beforeTranscriptCommit = undefined;
    mocks.stageSessionPendingInput.mockReset().mockImplementation(async (_scope, options) => {
      options.assertCurrent();
      const message = options.prepareMessageAfterIdempotencyCheck
        ? options.prepareMessageAfterIdempotencyCheck(options.message)
        : options.message;
      if (!message) {
        return undefined;
      }
      mocks.beforeTranscriptCommit?.();
      options.assertCurrent();
      mocks.persistedMessages.push(message);
      return {
        inputId: "pending-user-turn",
        message,
        run: <T>(operation: () => T) => operation(),
        finish: vi.fn(),
      };
    });
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

  it.each(["missing session", "commit revocation", "media revocation"] as const)(
    "does not persist an unauthorized user turn after %s",
    async (failure) => {
      const sessionKey = "agent:main:worker-child";
      const sessionEntry: SessionEntry = { sessionId: "admitted-session", updatedAt: 1 };
      mocks.readSessionEntryReadOnlyInWorker.mockResolvedValue(
        failure === "missing session" ? undefined : sessionEntry,
      );
      let authorityActive = true;
      if (failure === "commit revocation") {
        mocks.beforeTranscriptCommit = () => {
          authorityActive = false;
        };
      } else if (failure === "media revocation") {
        mocks.persistInboundImagesForTranscript.mockImplementationOnce(async () => {
          authorityActive = false;
          return { entries: [{ id: "revoked-media", fact: {} }] };
        });
      }
      const message = "must not outlive the admitted turn";
      await expect(
        prepareAgentRunUserTurn({
          request: { message, idempotencyKey: "admitted-run" },
          cfg: {},
          sessionEntry,
          resolvedSessionKey: sessionKey,
          sessionStorePath: "/tmp/sessions.json",
          admittedSessionId: sessionEntry.sessionId,
          activeSessionAgentId: "main",
          suppressVisibleSessionEffects: false,
          requestedPromptPersistenceSuppression: false,
          canUseInternalRuntimeHandoff: false,
          message,
          effectiveTranscriptInputText: message,
          images: [],
          offloadedRefs: [],
          runId: "admitted-run",
          client: null,
          context: { logGateway: { warn: vi.fn() } } as unknown as AgentTurnContext,
          assertCurrent: () => {
            if (!authorityActive) {
              throw new TypeError("agent runtime authority is no longer active");
            }
          },
        }),
      ).rejects.toThrow(
        failure === "missing session"
          ? "agent turn was not durably admitted"
          : "agent runtime authority is no longer active",
      );
      if (failure === "missing session") {
        expect(mocks.persistSessionTranscriptTurn).not.toHaveBeenCalled();
      } else {
        expect(mocks.persistedMessages).toEqual([]);
      }
      if (failure === "media revocation") {
        expect(mocks.deleteMediaBuffer).toHaveBeenCalledWith("revoked-media", "inbound");
        expect(mocks.readSessionEntryReadOnlyInWorker).not.toHaveBeenCalled();
        expect(mocks.resolveSessionTranscriptRuntimeTarget).not.toHaveBeenCalled();
        expect(mocks.stageSessionPendingInput).not.toHaveBeenCalled();
      }
    },
  );
});
