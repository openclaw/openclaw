import { expect, it, vi } from "vitest";
import { acceptCompactionSuccessor } from "../../agents/embedded-agent-runner/compaction-successor.js";
import { getSessionControllerOperation } from "../../sessions/session-controller.js";
import { acknowledgeReplySessionTransition } from "../../sessions/session-controller.state.js";
import { judgment } from "./group-participation.decision.test-support.js";
import {
  acceptGroupInputForActiveReply,
  fixture,
  models,
} from "./group-participation.runner.test-support.js";

const preflight = vi.hoisted(() =>
  vi.fn<typeof import("./agent-runner-memory.js").runSessionCompactionIfNeeded>(),
);
vi.mock("./agent-runner-memory.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./agent-runner-memory.js")>()),
  runSessionCompactionIfNeeded: preflight,
}));

it("binds model tool authority to the committed successor after deferred preparation", async () => {
  const groupId = "-10126";
  const sessionKey = `agent:main:telegram:group:${groupId}`;
  const successorId = "00000000-0000-4000-8000-000000010126";
  let predecessorId: string | undefined;
  preflight.mockImplementation(async (params) => {
    const entry = params.sessionEntry;
    if (!entry) {
      throw new Error("The admitted session is missing");
    }
    predecessorId = entry.sessionId;
    const target = {
      agentId: "main",
      sessionKey,
      storePath: fixture.storePath,
      sessionId: entry.sessionId,
    };
    const accepted = await acceptCompactionSuccessor({
      currentTarget: target,
      expectedEntry: {
        sessionId: entry.sessionId,
        lifecycleRevision: entry.lifecycleRevision,
        activeWriterRunId: entry.activeWriterRunId,
      },
      config: fixture.config,
      assertActive: () => params.replyOperation?.abortSignal.throwIfAborted(),
      result: {
        ok: true,
        compacted: true,
        result: {
          tokensBefore: 100,
          tokensAfter: 10,
          sessionId: successorId,
          sessionTarget: { ...target, sessionId: successorId },
        },
      },
    });
    if (accepted.admissionTransition) {
      await acknowledgeReplySessionTransition(params.replyOperation, accepted.admissionTransition);
    }
    params.onSessionIdChanged?.(accepted.entry.sessionId);
    return accepted.entry;
  });
  models.decision.mockImplementationOnce(async (batch) => judgment(batch, { attention: "none" }));
  models.decision.mockImplementation(async (batch) => judgment(batch, { attention: "engagement" }));
  let boundSessionId: string | undefined;
  let fingerprint: string | undefined;
  models.embedded.mockImplementation(async (params) => {
    const operation = getSessionControllerOperation(sessionKey);
    if (!operation) {
      throw new Error("The approved reply owner is missing");
    }
    // The real embedded harness uses this same authority owner before model dispatch.
    fingerprint = await operation.bindToolAuthorityRouteAsync({
      provider: params.provider ?? "openai",
      model: params.model ?? "test-model",
    });
    boundSessionId = params.sessionId;
    return { payloads: [{ text: "The approved answer." }], meta: { durationMs: 1 } };
  });
  const reply = await fixture.reply("Bob, which port?", "rotated-approval", groupId, {
    onRunVerbosityResolved: () => acceptGroupInputForActiveReply(groupId),
  });
  expect(reply).toMatchObject({ text: "The approved answer." });
  expect(predecessorId).toBeDefined();
  expect(predecessorId).not.toBe(successorId);
  expect(boundSessionId).toBe(successorId);
  expect(fingerprint).toBeTypeOf("string");
});
