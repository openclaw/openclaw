// Preserve registry fixtures before the cancellation entrypoint loads.
// oxfmt-ignore
import { useChatAbortRegistryFixture } from "./chat.abort-registry.test-support.js";
import { expect, it, vi } from "vitest";
import { awaitGateBeforeSettlement, createDeferred } from "../../../test/helpers/promise.js";
import { getRuntimeConfig } from "../../config/config.js";
import { replaceSessionEntry } from "../../config/sessions/session-accessor.js";
import { rpcSourceTesting } from "../../sessions/session-lifecycle-admission.test-support.js";
import * as sessionUtils from "../session-utils.js";
import { handleChatAbortRequestWithLifecycle } from "./chat-abort-handler.js";
import {
  createActiveRun,
  createChatAbortContext,
  invokeChatAbortHandler,
} from "./chat.abort.test-helpers.js";

useChatAbortRegistryFixture();

it.each(["completed", "replaced"] as const)(
  "exact Stop handles a run that is %s during metadata preparation",
  async (disposition) => {
    const sessionKey = "agent:main:main";
    const sessionId = "completed-session";
    await replaceSessionEntry(
      { agentId: "main", sessionKey },
      { sessionId, updatedAt: Date.now() },
    );
    const context = createChatAbortContext({ getRuntimeConfig });
    const original = createActiveRun(sessionKey, { sessionId, agentId: "main" });
    const successor = createActiveRun(sessionKey, { sessionId, agentId: "main" });
    rpcSourceTesting.set("run", original);
    const entered = createDeferred();
    const resume = createDeferred();
    const read = sessionUtils.loadGatewaySessionEntryReadOnlyInWorker;
    const metadata = vi
      .spyOn(sessionUtils, "loadGatewaySessionEntryReadOnlyInWorker")
      .mockImplementationOnce(async (params) => {
        const snapshot = await read(params);
        entered.resolve();
        await resume.promise;
        return snapshot;
      });
    const respond = vi.fn();
    const stopping = invokeChatAbortHandler({
      handler: handleChatAbortRequestWithLifecycle,
      context,
      request: { sessionKey, runId: "run" },
      client: { connect: { scopes: ["operator.admin"] } },
      respond,
    }).then(
      () => undefined,
      (error: unknown) => error,
    );
    try {
      await awaitGateBeforeSettlement(
        entered.promise,
        stopping,
        "Stop settled before metadata read",
      );
      expect(rpcSourceTesting.deleteExpected("run", original)).toBe(true);
      if (disposition === "replaced") {
        rpcSourceTesting.set("run", successor);
      }
      resume.resolve();
      const error = await stopping;
      if (disposition === "completed") {
        expect(error).toBeUndefined();
        expect(respond).toHaveBeenCalledWith(true, { ok: true, aborted: false, runIds: [] });
      } else {
        expect(error).toMatchObject({ message: "Run changed before cancellation; retry Stop." });
        expect(respond).not.toHaveBeenCalled();
      }
      expect(original.input.abortSignal.aborted).toBe(false);
      expect(successor.input.abortSignal.aborted).toBe(false);
      expect(context.broadcast).not.toHaveBeenCalled();
      expect(context.nodeSendToSession).not.toHaveBeenCalled();
    } finally {
      resume.resolve();
      await stopping;
      metadata.mockRestore();
    }
  },
);
