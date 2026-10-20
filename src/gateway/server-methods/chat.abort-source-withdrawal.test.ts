import { describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import * as withdrawal from "../../config/sessions/session-pending-input-withdrawal.js";
import { captureSessionTarget } from "../../sessions/session-controller.lifecycle.js";
import {
  isRpcSourceQueued,
  updateRpcSourceSessionId,
} from "../../sessions/session-controller.rpc-sources.js";
import { registerChatAbortController } from "../chat-abort.js";
import { createRpcSourceForTest, claimRpcSourceForTest } from "../test-helpers.rpc-source.js";
import { handleChatAbortRequestWithLifecycle } from "./chat-abort-handler.js";
import {
  createActiveRun as createUnscopedRun,
  createChatAbortContext,
  invokeChatAbortHandler,
} from "./chat.abort.test-helpers.js";

vi.mock("../session-utils.js", async (original) => ({
  ...(await original<typeof import("../session-utils.js")>()),
  loadGatewaySessionEntryReadOnlyInWorker: async () => ({
    cfg: {},
    agentId: "main",
    canonicalKey: "main",
    entry: { sessionId: "main-session" },
    storePath: "/synthetic/withdrawal/sessions.json",
  }),
}));

function queuedRun(runId: string) {
  const source = createUnscopedRun("main", {
    storeScope: "/synthetic/withdrawal/sessions.json",
    sessionId: "main-session",
    agentId: "main",
    queued: true,
    runId,
  });
  const context = createChatAbortContext({
    sources: [[runId, source]],
    getSessionEventSubscriberConnIds: () => new Set(),
  });
  return { source, context };
}

function withdraw(
  context: Parameters<typeof invokeChatAbortHandler>[0]["context"],
  runId: string,
  handler = handleChatAbortRequestWithLifecycle,
) {
  return invokeChatAbortHandler({
    handler,
    context,
    request: { sessionKey: "main", runId, discardPendingInput: true },
    client: { connect: { scopes: ["operator.admin"] } },
  });
}

describe("chat.abort exact controller input withdrawal", () => {
  it("retains captured identity when duplicate admission is refused during withdrawal", async () => {
    const runId = "withdrawal-collision";
    const { source, context } = queuedRun(runId);
    let foreign: ReturnType<typeof registerChatAbortController> | undefined;
    const discard = vi
      .spyOn(withdrawal, "discardSessionPendingInput")
      .mockImplementation(async (_scope, _runId, assertCurrent) => {
        assertCurrent();
        // Duplicate admission cannot replace the source retained by the write.
        foreign = registerChatAbortController({
          target: captureSessionTarget({
            storeScope: "/synthetic/foreign-withdrawal/sessions.json",
            sessionKey: "main",
            incarnation: "main-session",
            agentId: "main",
          }),
          sessionKey: "main",
          sessionId: "main-session",
          agentId: "main",
          timeoutMs: 60_000,
          runId,
        });
        expect(foreign.registered).toBe(false);
        updateRpcSourceSessionId(source, "rebound-session");
        assertCurrent();
        return true;
      });
    try {
      await expect(withdraw(context, runId)).rejects.toThrow("Run changed before input removal");
      expect(discard).toHaveBeenCalledOnce();
      expect(source.input.abortSignal.aborted).toBe(false);
      expect(foreign).toBeDefined();
      expect(foreign?.controller.signal.aborted).toBe(false);
      expect(source.input.withdrawalHolds).toBe(0);
    } finally {
      discard.mockRestore();
    }
  });

  it.each(["rejected", "committed and revoked"] as const)(
    "retains atomic input custody when the write is %s",
    async (outcome) => {
      const entered = createDeferred();
      const release = createDeferred();
      const { source: input, context } = queuedRun(" source ");
      let current = true;
      const discard = vi
        .spyOn(withdrawal, "discardSessionPendingInput")
        .mockImplementation(async (_scope, runId, assertCurrent) => {
          expect(runId).toBe(" source ");
          assertCurrent();
          entered.resolve();
          await release.promise;
          assertCurrent();
          if (outcome === "rejected") {
            throw new Error("write refused");
          }
          current = false;
          return true;
        });
      const stopping = withdraw(context, " source ", (options) =>
        handleChatAbortRequestWithLifecycle({
          ...options,
          hasCurrentClientAuthority: () => current,
        }),
      );
      try {
        await entered.promise;
        expect(input.input.withdrawalHolds).toBe(1);
        expect(input.input.abortSignal.aborted).toBe(false);
        release.resolve();
        if (outcome === "rejected") {
          await expect(stopping).rejects.toThrow("write refused");
          expect(isRpcSourceQueued(input)).toBe(true);
          expect(input.input.abortSignal.aborted).toBe(false);
        } else {
          const respond = await stopping;
          expect(input.input.abortSignal.aborted).toBe(true);
          expect(respond).toHaveBeenCalledWith(true, {
            ok: true,
            aborted: true,
            runIds: [" source "],
          });
        }
        expect(input.input.withdrawalHolds).toBe(0);
      } finally {
        release.resolve();
        await stopping.catch(() => {});
        discard.mockRestore();
      }
    },
  );

  it("never withdraws an execution claim or a byte-distinct protocol run", async () => {
    const source = createRpcSourceForTest(
      {},
      {
        runId: " source ",
        sessionKey: "main",
        sessionId: "main-session",
        agentId: "main",
      },
    );
    const release = await claimRpcSourceForTest(source);
    const context = createChatAbortContext({ sources: new Map([[" source ", source]]) });
    const discard = vi.spyOn(withdrawal, "discardSessionPendingInput");
    try {
      for (const runId of ["source", " source "]) {
        const respond = await withdraw(context, runId);
        expect(respond).toHaveBeenCalledWith(true, { ok: true, aborted: false, runIds: [] });
      }
      expect(discard).not.toHaveBeenCalled();
      expect(source.input.abortSignal.aborted).toBe(false);
    } finally {
      release();
      discard.mockRestore();
    }
  });
});
