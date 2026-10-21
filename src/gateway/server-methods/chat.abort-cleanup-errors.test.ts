// Preserve registry fixtures before the cancellation entrypoint loads.
// oxfmt-ignore
import { useChatAbortRegistryFixture } from "./chat.abort-registry.test-support.js";
import { expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import { createControlRunFixture } from "../../agents/subagents/registry/subagent-control.fixtures.test-support.js";
import { getRuntimeConfig } from "../../config/config.js";
import { loadSessionEntry, replaceSessionEntry } from "../../config/sessions/session-accessor.js";
import { trackSessionControllerSourceWork } from "../../sessions/session-controller.mailbox.js";
import { rpcSourceTesting } from "../../sessions/session-lifecycle-admission.test-support.js";
import * as chatAbortDescendants from "./chat-abort-descendants.js";
import { handleChatAbortRequestWithLifecycle } from "./chat-abort-handler.js";
import {
  createActiveRun,
  createChatAbortContext,
  invokeChatAbortHandler,
} from "./chat.abort.test-helpers.js";

const fixture = useChatAbortRegistryFixture();

it("reports a replaced child's refusal and failed persistence while raw cleanup is pending", async () => {
  const sessionKey = "agent:main:retained-parent";
  const sessionId = "retained-parent-session";
  const runId = "retained-parent-run";
  const childKey = "agent:main:subagent:replaced-child";
  const runs = createControlRunFixture(() => fixture.stateDir);
  await runs.writeSession("parent", "original-revision", {
    sessionKey,
    defaultSessionId: sessionId,
  });
  await runs.seed(
    "original-child",
    {
      runId: "original-child-run",
      childSessionKey: childKey,
      requesterSessionKey: sessionKey,
      requesterTurnRunId: runId,
      requesterDisplayKey: sessionKey,
      task: "retain the replacement child",
      collect: true,
      queued: true,
    },
    "original-revision",
  );
  const childSession = loadSessionEntry({ agentId: "main", sessionKey: childKey });
  const replacement = {
    ...childSession,
    sessionId: "replacement-child-session",
    lifecycleRevision: "replacement-revision",
    updatedAt: Date.now(),
  };
  await replaceSessionEntry({ agentId: "main", sessionKey: childKey }, replacement);
  const parent = createActiveRun(sessionKey, { runId, sessionId, agentId: "main" });
  const raw = createDeferred();
  trackSessionControllerSourceWork(parent.input, raw.promise);
  const terminalWrite = createDeferred();
  void terminalWrite.promise.catch(() => {});
  parent.adapter.projectSessionTerminalPersistence = terminalWrite.promise;
  const context = createChatAbortContext({ getRuntimeConfig, sources: new Map([[runId, parent]]) });
  const childrenStopped = createDeferred();
  const abortDescendants = chatAbortDescendants.abortControlledSubagents;
  const observed = vi
    .spyOn(chatAbortDescendants, "abortControlledSubagents")
    .mockImplementation(async (params) => {
      const result = await abortDescendants(params);
      childrenStopped.resolve();
      return result;
    });
  const sourceSettled = vi.fn();
  void parent.input.settlement.promise.then(sourceSettled);
  const respond = vi.fn();
  vi.useFakeTimers();
  const stopping = invokeChatAbortHandler({
    handler: handleChatAbortRequestWithLifecycle,
    context,
    request: { sessionKey, runId },
    client: { connect: { scopes: ["operator.admin"] } },
    respond,
  }).then(
    () => undefined,
    (error: unknown) => error,
  );
  try {
    await childrenStopped.promise;
    expect(parent.input.abortSignal.aborted).toBe(true);
    await vi.advanceTimersByTimeAsync(14_999);
    expect(respond).not.toHaveBeenCalled();
    terminalWrite.reject(new Error("Original parent terminal write failed"));
    await vi.advanceTimersByTimeAsync(0);
    expect(await stopping).toBeUndefined();
    expect(respond.mock.calls).toEqual([
      [
        false,
        undefined,
        expect.objectContaining({
          code: "UNAVAILABLE",
          message: expect.stringMatching(
            /Parent run stopped, but descendant cancellation was incomplete: .*original session incarnation is unresolved or changed/,
          ),
        }),
      ],
    ]);
    const message: unknown = respond.mock.calls[0]?.[2]?.message;
    expect(message).toContain("Original parent terminal write failed");
    expect(message).not.toContain("cleanup is still pending");
    expect(sourceSettled).not.toHaveBeenCalled();
    expect(rpcSourceTesting.get(runId)).toBe(parent);
    expect(loadSessionEntry({ agentId: "main", sessionKey: childKey })).toEqual(replacement);
  } finally {
    parent.adapter.projectSessionTerminalPersistence = undefined;
    raw.resolve();
    terminalWrite.resolve();
    await parent.input.settlement.promise;
    await stopping;
    observed.mockRestore();
    vi.useRealTimers();
  }
  expect(sourceSettled).toHaveBeenCalledOnce();
  expect(rpcSourceTesting.get(runId)).toBeUndefined();
});
