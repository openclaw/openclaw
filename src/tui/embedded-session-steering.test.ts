import { afterEach, expect, it, vi } from "vitest";
import { withMessageInjectionAdmission } from "../auto-reply/reply/message-injection-authority.js";
import { prepareReplyToolAuthority } from "../auto-reply/reply/reply-tool-authority.js";
import type { SessionEntry } from "../config/sessions/types.js";
import type {
  ReplyBackendQueueMessageOptions,
  ReplyToolAuthorityPreparation,
} from "../sessions/session-controller.contracts.js";
import { createReplyOperation } from "../sessions/session-controller.operation.js";
import { steerSessionControllerOperation } from "../sessions/session-controller.steer.js";
import { testing } from "../sessions/session-controller.test-support.js";
import { createDeferredCore } from "../shared/deferred.js";
import { INTERNAL_MESSAGE_CHANNEL } from "../utils/message-channel-constants.js";
import { steerEmbeddedSessionInput } from "./embedded-session-steering.js";

const senderId = "local-client";
const sessionEntry: SessionEntry = {
  sessionId: "local-session",
  updatedAt: 0,
  permissionMode: "full",
};

async function createLocalTurn(
  beforeAdmission?: (preparation: ReplyToolAuthorityPreparation) => Promise<void>,
) {
  const operation = createReplyOperation({
    sessionKey: "agent:main:tui-steering",
    sessionId: "local-session",
    resetTriggered: false,
    turnKind: "direct",
  });
  const queue = vi.fn((_text: string, _options?: ReplyBackendQueueMessageOptions) => {});
  const snapshot = prepareReplyToolAuthority({
    originatingChannel: INTERNAL_MESSAGE_CHANNEL,
    disableTools: false,
    run: {
      sessionId: "local-session",
      sessionFile: "/tmp/local-steering-session.jsonl",
      workspaceDir: "/tmp",
      provider: "openai",
      model: "gpt-test",
      config: {},
      messageProvider: INTERNAL_MESSAGE_CHANNEL,
      senderId,
      permissionMode: "full",
      senderIsOwner: false,
      traceAuthorized: false,
    },
  });
  await operation.bindToolAuthoritySnapshotAsync(snapshot);
  await operation.bindToolAuthorityRouteAsync({ provider: "openai", model: "gpt-test" });
  operation.attachBackend({
    kind: "embedded",
    runId: "local-run",
    cancel: () => {},
    supportsTranscriptCommitWait: true,
    messageInjectionV2: {
      version: 2,
      isAvailable: () => true,
      queueMessage: async () => {
        throw new Error("Local steering must use prepared V2 admission");
      },
      queueMessageAsync: async (text, options, preparation) => {
        await beforeAdmission?.(preparation);
        await withMessageInjectionAdmission(preparation.prepareCurrent, () => {
          preparation.assertCurrent();
          queue(text, options);
        });
      },
    },
  });
  operation.setPhase("running");
  function steer(changes: Partial<Parameters<typeof steerEmbeddedSessionInput>[0]> = {}) {
    return steerEmbeddedSessionInput({
      operation,
      text: "use the release branch",
      senderId,
      debounceMs: 0,
      abortSignal: new AbortController().signal,
      sessionEntry,
      ...changes,
    });
  }
  return { operation, queue, steer };
}

afterEach(() => testing.resetSessionControllerForTest());

it("steers a local user turn through prepared controller admission", async () => {
  const { operation, queue, steer } = await createLocalTurn();
  await expect(
    steerSessionControllerOperation({
      operation,
      text: "unprepared input",
      options: { steeringMode: "all", isInboundUserMessage: true },
    }),
  ).resolves.toMatchObject({ status: "rejected", reason: "tool_authority_mismatch" });
  expect(queue).not.toHaveBeenCalled();

  await expect(steer()).resolves.toMatchObject({ status: "accepted", targetRunId: "local-run" });
  expect(queue.mock.calls.map(([text]) => text)).toEqual(["use the release branch"]);
});

it.each([
  { sessionEntry: { ...sessionEntry, permissionMode: "guarded" } },
  { sessionEntry: { ...sessionEntry, toolOverrides: { webSearch: false } } },
  { senderId: "other-local-client" },
] satisfies { sessionEntry?: SessionEntry; senderId?: string }[])(
  "rejects changed local authority: %j",
  async (changed) => {
    const { queue, steer } = await createLocalTurn();
    await expect(steer(changed)).resolves.toMatchObject({
      status: "rejected",
      reason: "tool_authority_mismatch",
    });
    expect(queue).not.toHaveBeenCalled();
  },
);

it("propagates source cancellation before native enqueue", async () => {
  const entered = createDeferredCore();
  const resume = createDeferredCore();
  const source = new AbortController();
  const { queue, steer } = await createLocalTurn(async (preparation) => {
    await preparation.prepareCurrent();
    entered.resolve();
    await resume.promise;
  });
  const pending = steer({ text: "do not execute after stop", abortSignal: source.signal });
  await expect(
    Promise.race([entered.promise.then(() => "preparing"), pending.then(() => "settled")]),
  ).resolves.toBe("preparing");
  source.abort(new Error("Local TUI stopped"));
  resume.resolve();
  await expect(pending).rejects.toThrow("Local TUI stopped");
  expect(queue).not.toHaveBeenCalled();
});
