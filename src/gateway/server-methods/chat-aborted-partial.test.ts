import path from "node:path";
import { expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import {
  CLI_PARTIAL_OUTPUT_REJECTED_ERROR_CODE,
  FailoverError,
} from "../../agents/failover/error.js";
import {
  loadSessionEntry,
  loadTranscriptEvents,
  replaceSessionEntry,
} from "../../config/sessions/session-accessor.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import { trackAsyncWork } from "../../shared/async-work-scope.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { captureAbortedPartial, deferAbortedPartialPersistence } from "./chat-aborted-partial.js";

it.each([
  {
    name: "rejected partial",
    code: CLI_PARTIAL_OUTPUT_REJECTED_ERROR_CODE,
    wrapped: false,
    retained: false,
  },
  {
    name: "wrapped rejected partial",
    code: CLI_PARTIAL_OUTPUT_REJECTED_ERROR_CODE,
    wrapped: true,
    retained: false,
  },
  { name: "unrelated format failure", code: undefined, wrapped: false, retained: true },
])("honors the settled producer's $name", async ({ code, wrapped, retained }) => {
  await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
    const scope = {
      agentId: "main",
      sessionKey: "agent:main:abort-partial",
      sessionId: "abort-session",
      storePath: path.join(state.sessionsDir(), "sessions.json"),
    };
    await replaceSessionEntry(scope, { sessionId: scope.sessionId, updatedAt: 1 });
    const cfg = { agents: { entries: { main: {} } } };
    const producer = createDeferred<unknown>();
    let settlement: Promise<void> | undefined;
    const text = "Buffered text is not validation evidence";
    const snapshot = captureAbortedPartial({
      ...scope,
      runId: "rejected-partial",
      text,
      abortOrigin: "rpc",
      session: {
        ok: true,
        value: {
          cfg,
          storePath: scope.storePath,
          entry: loadSessionEntry(scope),
          canonicalKey: scope.sessionKey,
          agentId: scope.agentId,
        },
      },
      resolveTerminalProducer: () => ({
        sessionId: scope.sessionId,
        sessionKey: scope.sessionKey,
        handoff: (settle) => {
          settlement = settle(producer.promise);
          return true;
        },
      }),
    });
    const warn = vi.fn();
    const before = await loadTranscriptEvents(scope);
    try {
      deferAbortedPartialPersistence(snapshot, {
        trackExecution: trackAsyncWork,
        logGateway: { ...createSubsystemLogger("test/abort-partial"), warn },
        broadcast: vi.fn(),
        nodeSendToSession: vi.fn(),
        agentRunSeq: new Map(),
        getRuntimeConfig: () => cfg,
      });
      expect(settlement).toBeDefined();
      expect(await loadTranscriptEvents(scope)).toEqual(before);
      const failure = new FailoverError("Producer validation failed", { reason: "format", code });
      producer.resolve(
        wrapped ? new Error("Wrapped producer failure", { cause: failure }) : failure,
      );
      await settlement;
      const events = await loadTranscriptEvents(scope);
      if (retained) {
        expect(events).toContainEqual(
          expect.objectContaining({
            message: expect.objectContaining({
              role: "assistant",
              content: [{ type: "text", text }],
            }),
          }),
        );
      } else {
        expect(events).toEqual(before);
      }
      expect(warn).not.toHaveBeenCalled();
    } finally {
      producer.resolve(undefined);
      await settlement;
    }
  });
});
