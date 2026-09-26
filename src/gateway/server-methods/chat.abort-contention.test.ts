// Preserve registry fixture setup before importing its consumers.
// oxfmt-ignore
import { useChatAbortRegistryFixture } from "./chat.abort-registry.test-support.js";
import { afterEach, expect, it, vi } from "vitest";
import { StateDatabaseCoordinatorContentionError } from "../../infra/state-database-coordinator-errors.js";
import * as sessionUtils from "../session-utils.js";
import { handleChatAbortRequest } from "./chat-abort-handler.js";
import {
  createActiveRun,
  createChatAbortContext,
  invokeChatAbortHandler,
} from "./chat.abort.test-helpers.js";

useChatAbortRegistryFixture();
afterEach(() => vi.restoreAllMocks());

it("reports typed contention without replaying or denying an already applied Stop", async () => {
  const failure = new StateDatabaseCoordinatorContentionError("state-lifecycle");
  vi.spyOn(sessionUtils, "loadSessionEntry").mockImplementation(() => {
    throw failure;
  });
  const sessionKey = "agent:main:main";
  const active = createActiveRun(sessionKey, { agentId: "main" });
  const context = createChatAbortContext({ chatAbortControllers: new Map([["run-1", active]]) });
  const respond = await invokeChatAbortHandler({
    handler: handleChatAbortRequest,
    context,
    request: { sessionKey, runId: "run-1" },
    client: { connect: { scopes: ["operator.admin"] } },
  });
  expect(active.controller.signal.aborted).toBe(true);
  expect(respond).toHaveBeenCalledOnce();
  expect(respond).toHaveBeenCalledWith(
    false,
    undefined,
    expect.objectContaining({
      code: "UNAVAILABLE",
      message:
        "The server is busy. Check this turn's status before trying Stop again.\n\nStateDatabaseCoordinatorContentionError: state-lifecycle acquisition remained busy. Stopping may already have taken effect.",
      details: { errorKind: "state_contention" },
    }),
  );
});

it.each([
  new Error("StateDatabaseCoordinatorContentionError: private detail"),
  new AggregateError(
    [new StateDatabaseCoordinatorContentionError("state-lifecycle")],
    "cleanup failed",
  ),
])("does not certify strings or uncertain cleanup aggregates", async (error) => {
  const context = createChatAbortContext({
    getRuntimeConfig: () => {
      throw error;
    },
  });
  await expect(
    invokeChatAbortHandler({
      handler: handleChatAbortRequest,
      context,
      request: { sessionKey: "agent:main:main", runId: "run-1" },
    }),
  ).rejects.toBe(error);
});
