import { expect, it } from "vitest";
import { handleChatAbortRequestWithLifecycle } from "./chat-abort-handler.js";
import {
  createActiveRun,
  createChatAbortContext,
  invokeChatAbortHandler,
} from "./chat.abort.test-helpers.js";

it("does not attribute an ownerless default global run to the selected agent", async () => {
  const active = createActiveRun("global");
  const context = createChatAbortContext({
    chatAbortControllers: new Map([["run-main", active]]),
    getRuntimeConfig: () => ({
      agents: { list: [{ id: "main", default: true }, { id: "work" }] },
      session: { scope: "global" },
    }),
  });

  const respond = await invokeChatAbortHandler({
    handler: handleChatAbortRequestWithLifecycle,
    context,
    request: { sessionKey: "global", agentId: "work", runId: "run-main" },
  });

  expect(respond.mock.calls.at(-1)).toMatchObject([
    false,
    undefined,
    { code: "INVALID_REQUEST", message: "runId does not match agentId" },
  ]);
  expect(active.controller.signal.aborted).toBe(false);
});

it("rejects an ownerless bare-global run abort on an explicit fleet", async () => {
  const active = createActiveRun("global", { agentId: "research" });
  const context = createChatAbortContext({
    chatAbortControllers: new Map([["run-research", active]]),
    getRuntimeConfig: () => ({
      agents: { ownership: "explicit", entries: { ops: {}, research: {} } },
      session: { scope: "global" },
    }),
  });

  const respond = await invokeChatAbortHandler({
    handler: handleChatAbortRequestWithLifecycle,
    context,
    request: { sessionKey: "global", runId: "run-research" },
  });

  expect(respond.mock.calls.at(-1)).toMatchObject([
    false,
    undefined,
    {
      code: "INVALID_REQUEST",
      message: "agentId is required for global chat.abort when no compatibility owner exists",
    },
  ]);
  expect(active.controller.signal.aborted).toBe(false);
});

it("canonicalizes a bare explicit-fleet key with the selected agent", async () => {
  const active = createActiveRun("incident-42", { agentId: "work" });
  const context = createChatAbortContext({
    chatAbortControllers: new Map([["run-work", active]]),
    getRuntimeConfig: () => ({
      agents: { ownership: "explicit", entries: { ops: {}, work: {} } },
    }),
  });

  const respond = await invokeChatAbortHandler({
    handler: handleChatAbortRequestWithLifecycle,
    context,
    request: { sessionKey: "incident-42", agentId: "work", runId: "run-work" },
  });

  expect(respond.mock.calls.at(-1)?.[0]).toBe(true);
  expect(active.controller.signal.aborted).toBe(true);
});
