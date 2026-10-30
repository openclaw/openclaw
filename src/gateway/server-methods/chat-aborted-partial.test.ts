import path from "node:path";
import { expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import {
  CLI_PARTIAL_OUTPUT_REJECTED_ERROR_CODE,
  FailoverError,
} from "../../agents/failover/error.js";
import {
  loadTranscriptEvents,
  replaceSessionEntry,
} from "../../config/sessions/session-accessor.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import { trackAsyncWork } from "../../shared/async-work-scope.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import * as partial from "./chat-aborted-partial.js";

it.each([
  ["rejected partial", CLI_PARTIAL_OUTPUT_REJECTED_ERROR_CODE, false, false],
  ["wrapped rejected partial", CLI_PARTIAL_OUTPUT_REJECTED_ERROR_CODE, true, false],
  ["unrelated format failure", undefined, false, true],
] as const)("honors the settled producer's %s", (_name, code, wrapped, retained) =>
  withOpenClawTestState({ scenario: "minimal" }, async (state) => {
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
    const text = "Unvalidated partial";
    const snapshot = partial.captureAbortedPartial({
      ...scope,
      runId: "rejected-partial",
      text,
      abortOrigin: "rpc",
      session: await partial.prepareChatAbortSessionSnapshot({ cfg, key: scope.sessionKey }),
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
      partial.deferAbortedPartialPersistence(snapshot, {
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
      const message = expect.objectContaining({
        role: "assistant",
        content: [{ type: "text", text }],
      });
      expect(await loadTranscriptEvents(scope)).toEqual(
        retained ? expect.arrayContaining([expect.objectContaining({ message })]) : before,
      );
      expect(warn).not.toHaveBeenCalled();
    } finally {
      producer.resolve(undefined);
      await settlement;
    }
  }),
);
