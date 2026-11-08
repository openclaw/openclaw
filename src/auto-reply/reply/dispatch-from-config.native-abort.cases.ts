import { expect, it, vi } from "vitest";
import {
  awaitGateBeforeSettlement,
  createDeferred,
  withinTest,
} from "../../../test/helpers/promise.js";
import type { OpenClawConfig } from "../../config/config.js";
import { captureSessionControllerSourceSettlement } from "../../sessions/session-controller.mailbox.js";
import { createDispatcher, hookMocks } from "./dispatch-from-config.shared.test-harness.js";
import { expectedNoQueuedReplyResult } from "./dispatch-result-expectations.test-support.js";
import { requestCurrentSessionStop } from "./reply-run-stop.test-support.js";
import { prepareReplySourceInput } from "./reply-source-binding.js";
import { buildTestCtx } from "./test-ctx.js";

export function registerNativeDispatchAbortCases(
  getRuntime: () => {
    dispatchReplyFromConfig: typeof import("./dispatch-from-config.js").dispatchReplyFromConfig;
    getSessionControllerOperation: typeof import("../../sessions/session-controller.js").getSessionControllerOperation;
    createReplyOperation: typeof import("../../sessions/session-controller.js").createReplyOperation;
    listActiveReplyRunSessionKeys: typeof import("../../sessions/session-controller.queries.js").listActiveReplyRunSessionKeys;
    createDispatchConfig: (diagnostics?: boolean) => OpenClawConfig;
    expectNoReplies: (dispatcher: ReturnType<typeof createDispatcher>) => void;
  },
) {
  it("keeps native command pre-dispatch cancellation on its unclaimed source", async () => {
    const {
      dispatchReplyFromConfig,
      getSessionControllerOperation,
      listActiveReplyRunSessionKeys,
      createDispatchConfig,
      expectNoReplies,
    } = getRuntime();
    // Native control preparation keeps source custody without claiming a turn.
    hookMocks.runner.hasHooks.mockImplementation(
      (hookName?: string) => hookName === "before_dispatch",
    );
    const beforeDispatchStarted = createDeferred();
    const releaseBeforeDispatch = createDeferred();
    hookMocks.runner.runBeforeDispatch.mockImplementation(async () => {
      beforeDispatchStarted.resolve();
      await releaseBeforeDispatch.promise;
      return undefined;
    });

    const sourceSessionKey = "agent:main:discord:slash:user-1";
    const targetSessionKey = "agent:main:discord:channel:target-1";
    const dispatcher = createDispatcher();
    const ctx = buildTestCtx({
      Provider: "discord",
      Surface: "discord",
      CommandSource: "native",
      CommandTurn: {
        kind: "native",
        source: "native",
        authorized: true,
      },
      SessionKey: sourceSessionKey,
      CommandTargetSessionKey: targetSessionKey,
      BodyForAgent: "hang before command source dispatch",
    });
    const origin = new AbortController();
    const cfg = createDispatchConfig();
    const prepared = await prepareReplySourceInput(ctx, cfg, { abortSignal: origin.signal });
    if (!prepared.input) {
      throw new Error("missing native source");
    }
    const receipt = captureSessionControllerSourceSettlement(prepared.input);
    const settled = vi.fn();
    void receipt.then(settled);
    const dispatchPromise = dispatchReplyFromConfig({
      ctx,
      cfg,
      replyOptions: prepared.options,
      dispatcher,
      replyResolver: vi.fn(),
    });

    try {
      await beforeDispatchStarted.promise;
      expect(prepared.input.claim).toBeUndefined();
      expect(getSessionControllerOperation(sourceSessionKey)).toBeUndefined();
      expect(await requestCurrentSessionStop(targetSessionKey)).toBe(false);
      origin.abort();

      await expect(dispatchPromise).resolves.toMatchObject(expectedNoQueuedReplyResult());
      expect(getSessionControllerOperation(sourceSessionKey)).toBeUndefined();
      expect(getSessionControllerOperation(targetSessionKey)).toBeUndefined();
      expect(prepared.input.abortSignal.aborted).toBe(true);
      expect(settled).not.toHaveBeenCalled();

      releaseBeforeDispatch.resolve();
      await receipt;
      expect(settled).toHaveBeenCalledOnce();
      expectNoReplies(dispatcher);
      expect(listActiveReplyRunSessionKeys()).toEqual([]);
    } finally {
      releaseBeforeDispatch.resolve();
      await Promise.allSettled([dispatchPromise, receipt]);
    }
  });

  it("admits unauthorized native /stop on the source while the target has an active run", async ({
    signal,
  }) => {
    const {
      dispatchReplyFromConfig,
      getSessionControllerOperation,
      createReplyOperation,
      listActiveReplyRunSessionKeys,
      createDispatchConfig,
    } = getRuntime();
    const sourceSessionKey = "agent:main:telegram:slash:user-unauth";
    const targetSessionKey = "agent:main:telegram:group:target-run";
    const targetOperation = createReplyOperation({
      sessionKey: targetSessionKey,
      sessionId: "target-active-session",
      resetTriggered: false,
    });
    targetOperation.setPhase("running");

    const replyResolver = vi.fn(async () => ({
      text: "You are not authorized to use this command.",
    }));
    const dispatcher = createDispatcher();
    const ctx = buildTestCtx({
      Provider: "telegram",
      Surface: "telegram",
      CommandSource: "native",
      CommandAuthorized: false,
      CommandTurn: {
        kind: "native",
        source: "native",
        authorized: false,
        commandName: "stop",
        body: "/stop",
      },
      SessionKey: sourceSessionKey,
      CommandTargetSessionKey: targetSessionKey,
      Body: "/stop",
      RawBody: "/stop",
      CommandBody: "/stop",
      BodyForAgent: "/stop",
    });

    const dispatchPromise = dispatchReplyFromConfig({
      ctx,
      cfg: createDispatchConfig(),
      dispatcher,
      replyResolver,
    });

    try {
      const result = await withinTest(
        awaitGateBeforeSettlement(
          dispatchPromise,
          targetOperation.ownerSettlement,
          "Target operation settled before the unauthorized native command replied",
        ),
        signal,
      );
      expect(result).toMatchObject({ queuedFinal: true });
      expect(replyResolver).toHaveBeenCalledOnce();
      expect(dispatcher.sendFinalReply).toHaveBeenCalledWith({
        text: "You are not authorized to use this command.",
      });
      // Target run must remain active — command admission is source-keyed.
      expect(targetOperation.result).toBeNull();
      expect(getSessionControllerOperation(targetSessionKey)).toBe(targetOperation);
      expect(getSessionControllerOperation(sourceSessionKey)).toBeUndefined();
    } finally {
      targetOperation.complete();
      await Promise.allSettled([dispatchPromise]);
    }
    expect(listActiveReplyRunSessionKeys()).toEqual([]);
  });

  it("does not let a current-session fast abort abort its own dispatch operation", async () => {
    const { dispatchReplyFromConfig, listActiveReplyRunSessionKeys, createDispatchConfig } =
      getRuntime();
    const dispatcher = createDispatcher();
    const ctx = buildTestCtx({
      Provider: "discord",
      Surface: "discord",
      SessionKey: "agent:main:self-stop",
      BodyForAgent: "/stop",
    });
    const replyResolver = vi.fn();

    await expect(
      dispatchReplyFromConfig({
        ctx,
        cfg: createDispatchConfig(),
        dispatcher,
        replyOptions: { sourceReplyDeliveryMode: "automatic" },
        replyResolver,
        fastAbortResolver: async () => {
          expect(await requestCurrentSessionStop("agent:main:self-stop")).toBe(false);
          return { handled: true, aborted: true };
        },
        formatAbortReplyTextResolver: () => "stopped",
      }),
    ).resolves.toMatchObject({
      queuedFinal: true,
    });

    expect(replyResolver).not.toHaveBeenCalled();
    expect(dispatcher.sendFinalReply).toHaveBeenCalledWith({ text: "stopped" });
    expect(listActiveReplyRunSessionKeys()).toEqual([]);
  });
}
