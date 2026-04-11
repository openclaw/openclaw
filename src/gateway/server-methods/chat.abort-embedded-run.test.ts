import { describe, expect, it, vi } from "vitest";
import {
  createActiveRun,
  createChatAbortContext,
  invokeChatAbortHandler,
} from "./chat.abort.test-helpers.js";

const abortEmbeddedPiRun = vi.fn(() => true);
vi.mock("../../agents/pi-embedded.js", () => ({ abortEmbeddedPiRun }));

const stopSubagentsForRequester = vi.fn(() => ({ stopped: 0 }));
vi.mock("../../auto-reply/reply/abort.js", () => ({ stopSubagentsForRequester }));

const clearSessionQueues = vi.fn(() => ({ followupCleared: 0, laneCleared: 0, keys: [] }));
vi.mock("../../auto-reply/reply/queue.js", () => ({ clearSessionQueues }));

vi.mock("../session-utils.js", async (importOriginal) => {
  const original = await importOriginal<typeof import("../session-utils.js")>();
  return {
    ...original,
    loadSessionEntry: () => ({
      cfg: { agents: {} },
      storePath: "/tmp/sessions.json",
      entry: { sessionId: "sess-1" },
      canonicalKey: "main",
    }),
  };
});

const { chatHandlers } = await import("./chat.js");

describe("chat.abort stops embedded Pi agent and sub-agents", () => {
  it("calls abortEmbeddedPiRun when aborting by sessionKey", async () => {
    const context = createChatAbortContext({
      chatAbortControllers: new Map([["run-1", createActiveRun("main", { sessionId: "sess-1" })]]),
    });
    abortEmbeddedPiRun.mockClear();
    stopSubagentsForRequester.mockClear();
    clearSessionQueues.mockClear();

    await invokeChatAbortHandler({
      handler: chatHandlers["chat.abort"],
      context,
      request: { sessionKey: "main" },
    });

    expect(abortEmbeddedPiRun).toHaveBeenCalledWith("sess-1");
    expect(clearSessionQueues).toHaveBeenCalledWith(["main", "sess-1"]);
    expect(stopSubagentsForRequester).toHaveBeenCalledWith(
      expect.objectContaining({ requesterSessionKey: "main" }),
    );
  });

  it("calls abortEmbeddedPiRun when aborting by runId", async () => {
    const context = createChatAbortContext({
      chatAbortControllers: new Map([["run-1", createActiveRun("main", { sessionId: "sess-1" })]]),
    });
    abortEmbeddedPiRun.mockClear();
    stopSubagentsForRequester.mockClear();
    clearSessionQueues.mockClear();

    await invokeChatAbortHandler({
      handler: chatHandlers["chat.abort"],
      context,
      request: { sessionKey: "main", runId: "run-1" },
    });

    expect(abortEmbeddedPiRun).toHaveBeenCalledWith("sess-1");
    expect(clearSessionQueues).toHaveBeenCalledWith(["main", "sess-1"]);
    expect(stopSubagentsForRequester).toHaveBeenCalledWith(
      expect.objectContaining({ requesterSessionKey: "main" }),
    );
  });

  it("does not call abort functions when run is not found", async () => {
    const context = createChatAbortContext();
    abortEmbeddedPiRun.mockClear();
    stopSubagentsForRequester.mockClear();
    clearSessionQueues.mockClear();

    await invokeChatAbortHandler({
      handler: chatHandlers["chat.abort"],
      context,
      request: { sessionKey: "main", runId: "nonexistent" },
    });

    expect(abortEmbeddedPiRun).not.toHaveBeenCalled();
    expect(clearSessionQueues).not.toHaveBeenCalled();
    expect(stopSubagentsForRequester).not.toHaveBeenCalled();
  });
});
