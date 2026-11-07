// Preserve module setup before modules that consume it.
// oxfmt-ignore
import { useChatAbortRegistryFixture } from "./chat.abort-registry.test-support.js";
import { expect, it, vi } from "vitest";
import {
  clearTestEmbeddedRun as clearActiveEmbeddedRun,
  registerTestEmbeddedRun as setActiveEmbeddedRun,
  createEmbeddedRunHandle,
} from "../../agents/embedded-agent-runner/runs.test-support.js";
import { getRuntimeConfig } from "../../config/config.js";
import { createDirectChatContext } from "../server-chat.agent-events.test-helpers.js";
import { handleGatewayRequest } from "../server-methods.js";
import { roleClient } from "../session-sharing.test-utils.js";
import * as sessionWorkerReads from "../session-utils-store-worker.js";
import { sessionAbortHandlers } from "./sessions-abort.js";
import { createEmbeddedSessionFixture } from "./sessions.abort-embedded.test-support.js";

useChatAbortRegistryFixture();
const parentKey = "agent:main:direct:contention-parent";
const parentId = "contention-parent-session";
const { seed } = createEmbeddedSessionFixture(parentKey, parentId);

it("sessions.abort reports typed contention after an applied Stop", async () => {
  const runId = "contention-embedded-run";
  await seed(runId);
  let stopped = false;
  const abort = vi.fn(() => {
    stopped = true;
    clearActiveEmbeddedRun(parentId, handle, parentKey);
  });
  const handle = createEmbeddedRunHandle({ runId, abort });
  setActiveEmbeddedRun(parentId, handle, parentKey, undefined, "main");
  const failure = Object.assign(new Error("database is locked"), {
    code: "ERR_SQLITE_ERROR",
    errcode: 5,
  });
  const read = sessionWorkerReads.loadGatewaySessionEntryReadOnlyInWorker;
  const reader = vi
    .spyOn(sessionWorkerReads, "loadGatewaySessionEntryReadOnlyInWorker")
    .mockImplementation((...args) => (stopped ? Promise.reject(failure) : read(...args)));
  const respond = vi.fn();
  const client = roleClient("write", "contention-operator");
  try {
    let thrown: unknown;
    await handleGatewayRequest({
      req: { type: "req", id: "stop", method: "sessions.abort", params: { key: parentKey, runId } },
      client,
      context: createDirectChatContext({ getRuntimeConfig }),
      respond,
      isWebchatConnect: () => false,
      extraHandlers: { "sessions.abort": sessionAbortHandlers["sessions.abort"]! },
    }).catch((error: unknown) => {
      thrown = error;
    });
    expect(abort).toHaveBeenCalledOnce();
    expect(thrown).toBeUndefined();
    expect(respond).toHaveBeenCalledOnce();
    expect(respond).toHaveBeenCalledWith(
      false,
      undefined,
      expect.objectContaining({
        code: "UNAVAILABLE",
        message:
          "The server is busy. Check this turn's status before trying Stop again.\n\nSQLite transaction admission remained busy. Stopping may already have taken effect.",
        details: { errorKind: "state_contention" },
      }),
    );
  } finally {
    reader.mockRestore();
    clearActiveEmbeddedRun(parentId, handle, parentKey);
  }
});
