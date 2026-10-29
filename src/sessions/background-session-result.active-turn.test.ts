import path from "node:path";
import { Type } from "typebox";
import { afterEach, expect, it } from "vitest";
import { transformMessages } from "../../packages/ai/src/transcript-transform.js";
import { withinTest } from "../../test/helpers/promise.js";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { sanitizeSessionHistory } from "../agents/embedded-agent-runner/replay-history.js";
import {
  createAssistant,
  createAssistantResultStream,
  createTestSession,
  registerAgentSessionLoopTestLifecycle,
  streamMocks,
  testModel,
} from "../agents/sessions/agent-session-loop-correctness.test-support.js";
import { SessionManager } from "../agents/sessions/session-manager.js";
import { replaceSessionEntry } from "../config/sessions/session-accessor.js";
import type { Message } from "../llm/types.js";
import { createDeferredCore } from "../shared/deferred.js";
import {
  closeOpenClawAgentDatabasesAsync,
  closeOpenClawAgentDatabasesForTest,
} from "../state/openclaw-agent-db.js";
import { commitBackgroundResultToSession } from "./background-session-result.js";
import {
  beginSessionWorkAdmission,
  getActiveSessionLifecycleMutationCount,
} from "./session-lifecycle-admission.js";
registerAgentSessionLoopTestLifecycle();
const tempDirs = useAutoCleanupTempDirTracker((cleanup) =>
  afterEach(async () => {
    for (const root of tempDirs.dirs) {
      await closeOpenClawAgentDatabasesAsync(root);
      closeOpenClawAgentDatabasesForTest(root);
    }
    cleanup();
  }),
);
async function createTarget() {
  const dir = tempDirs.make("openclaw-background-live-");
  const storePath = path.join(dir, "agents", "main", "sessions", "sessions.json");
  const sessionKey = "agent:main:webchat:direct:owner";
  const sessionId = "source-session";
  const scope = { agentId: "main", storePath, sessionKey, sessionId };
  const generation = { sessionId, lifecycleRevision: "source-revision" };
  await replaceSessionEntry(scope, { ...generation, updatedAt: 1 });
  return {
    ...scope,
    scope,
    commit: () =>
      commitBackgroundResultToSession({
        ...scope,
        expectedGeneration: generation,
        text: "Automation completed",
        idempotencyKey: "live-completion",
        provenance: { kind: "cron", jobId: "live", runId: "live" },
        config: { session: { store: storePath } },
      }),
  };
}
it("preserves live and replayed tool results when automation commits during tool execution", async ({
  signal,
}) => {
  const target = await createTarget();
  const manager = await SessionManager.openAsync(target.scope);
  const entered = createDeferredCore();
  const finishTool = createDeferredCore();
  const requests: Message[][] = [];
  streamMocks.streamSimple.mockImplementation((model, context) => {
    requests.push(structuredClone(context.messages));
    return createAssistantResultStream(
      requests.length === 1
        ? createAssistant(
            model,
            [{ type: "toolCall", id: "lookup-call", name: "lookup", arguments: {} }],
            "toolUse",
          )
        : createAssistant(model, [{ type: "text", text: "Lookup completed" }]),
    );
  });
  const { session } = await createTestSession({
    sessionManager: manager,
    customTools: [
      {
        name: "lookup",
        label: "Lookup",
        description: "Synthetic lookup",
        parameters: Type.Object({}),
        execute: async () => {
          entered.resolve();
          await finishTool.promise;
          return { content: [{ type: "text", text: "Actual lookup result" }], details: {} };
        },
      },
    ],
  });
  const admission = await beginSessionWorkAdmission({
    scope: target.storePath,
    identities: [target.sessionKey, target.sessionId],
    assertAllowed() {},
  });
  const turn = admission.run(() => session.prompt("Run lookup"));
  try {
    await withinTest(entered.promise, signal);
    await expect(withinTest(target.commit(), signal)).resolves.toMatchObject({ ok: true });
    expect(getActiveSessionLifecycleMutationCount()).toBe(0);
    finishTool.resolve();
    await withinTest(turn, signal);
    expect(requests).toHaveLength(2);
    expect(requests[1]).toMatchObject([
      { role: "user" },
      { role: "assistant", content: [{ type: "toolCall", id: "lookup-call" }] },
      { role: "toolResult", toolCallId: "lookup-call", isError: false },
    ]);
    const reopened = await SessionManager.openAsync(target.scope);
    const stored = reopened.buildSessionContext().messages;
    expect(stored).toMatchObject([
      { role: "user" },
      { role: "assistant", content: [{ type: "toolCall", id: "lookup-call" }] },
      { role: "assistant", model: "automation-result" },
      { role: "toolResult", toolCallId: "lookup-call", isError: false },
      { role: "assistant" },
    ]);
    const replay = await sanitizeSessionHistory({
      messages: stored,
      sessionManager: reopened,
      sessionId: target.sessionId,
      provider: testModel.provider,
      modelId: testModel.id,
      modelApi: testModel.api,
      config: { plugins: { enabled: false } },
    });
    const providerMessages = replay.filter(
      (message): message is Message =>
        message.role === "user" || message.role === "assistant" || message.role === "toolResult",
    );
    const transformed = transformMessages(providerMessages, testModel);
    expect(transformed).toMatchObject([
      { role: "user" },
      { role: "assistant", content: [{ type: "toolCall", id: expect.any(String) }] },
      {
        role: "toolResult",
        toolCallId: expect.any(String),
        content: [{ type: "text", text: "Actual lookup result" }],
        isError: false,
      },
      { role: "assistant", model: "automation-result" },
      { role: "assistant" },
    ]);
    const call = transformed[1];
    const result = transformed[2];
    if (call?.role !== "assistant" || result?.role !== "toolResult") {
      throw new Error("Expected paired tool call and result");
    }
    expect(call.content).toMatchObject([{ type: "toolCall", id: result.toolCallId }]);
    expect(manager.buildSessionContext().messages).toEqual(stored);
  } finally {
    finishTool.resolve();
    await turn;
    admission.release();
  }
});
