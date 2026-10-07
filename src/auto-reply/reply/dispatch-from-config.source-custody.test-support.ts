import { expect, it, vi } from "vitest";
import { awaitGateBeforeSettlement, createDeferred } from "../../../test/helpers/promise.js";
import type { MsgContext } from "../templating.js";
import type { GetReplyOptions, ReplyPayload } from "../types.js";
import {
  createDispatcher,
  emptyConfig,
  hookMocks,
  sessionStoreMocks,
} from "./dispatch-from-config.shared.test-harness.js";
import {
  dispatchReplyFromConfig,
  replyRunRegistry,
  setNoAbort,
} from "./dispatch-from-config.test-harness.js";
import type { InternalGetReplyOptions } from "./get-reply.types.js";
import type { ReplyOperation } from "./reply-run-registry.js";
import { buildTestCtx } from "./test-ctx.js";

// Registered in the original suite so its shared fixtures and lifecycle remain authoritative.
export function registerDispatchSourceCustodyTests(): void {
  it("releases inbound dedupe when durable ingress aborts before adoption", async () => {
    setNoAbort();
    hookMocks.runner.hasHooks.mockImplementation(
      ((hookName?: string) => hookName === "before_dispatch") as () => boolean,
    );
    let markHookStarted!: () => void;
    const hookStarted = new Promise<void>((resolve) => {
      markHookStarted = resolve;
    });
    let releaseHook!: () => void;
    const hookRelease = new Promise<void>((resolve) => {
      releaseHook = resolve;
    });
    hookMocks.runner.runBeforeDispatch
      .mockImplementationOnce(async () => {
        markHookStarted();
        await hookRelease;
        return undefined;
      })
      .mockResolvedValue(undefined);

    const ctx = buildTestCtx({
      Provider: "telegram",
      Surface: "telegram",
      OriginatingChannel: "telegram",
      OriginatingTo: "user:1",
      SessionKey: "agent:main:telegram:direct:1",
      MessageSid: "pre-adoption-retry",
      BodyForAgent: "retry me",
    });
    const abortController = new AbortController();
    const replyResolver = vi.fn(async () => ({ text: "retried" }) satisfies ReplyPayload);
    const turnAdoptionLifecycle = {
      onAdopted: vi.fn(async () => {}),
      onDeferred: vi.fn(),
      onSettled: vi.fn(),
    };

    const firstDispatch = dispatchReplyFromConfig({
      ctx,
      cfg: emptyConfig,
      dispatcher: createDispatcher(),
      replyOptions: {
        abortSignal: abortController.signal,
        turnAdoptionLifecycle,
      },
      replyResolver,
    });
    await hookStarted;
    abortController.abort(new Error("handler-timeout"));
    releaseHook();
    await expect(firstDispatch).resolves.toMatchObject({ queuedFinal: false });
    expect(replyResolver).not.toHaveBeenCalled();

    await dispatchReplyFromConfig({
      ctx,
      cfg: emptyConfig,
      dispatcher: createDispatcher(),
      replyOptions: { turnAdoptionLifecycle },
      replyResolver,
    });
    expect(replyResolver).toHaveBeenCalledOnce();
  });

  it("retains an internal event's exact owner until its aborted pre-adoption resolver settles", async () => {
    setNoAbort();
    const sessionKey = "agent:main:event-pre-adoption-custody";
    sessionStoreMocks.currentEntry = { sessionId: "event-session", updatedAt: Date.now() };
    const resolverEntered = createDeferred<ReplyOperation | undefined>();
    const releaseResolver = createDeferred();
    const abort = new AbortController();
    const onAdopted = vi.fn();
    const onReplyOperationOwned = vi.fn<(operation: ReplyOperation) => void>();
    let resolverFinished = false;
    let ownerSettled = false;
    const replyResolver = async (_ctx: MsgContext, opts?: InternalGetReplyOptions) => {
      resolverEntered.resolve(opts?.replyOperation);
      await releaseResolver.promise;
      resolverFinished = true;
      return undefined;
    };
    const dispatch = dispatchReplyFromConfig({
      ctx: buildTestCtx({
        Provider: "webchat",
        Surface: "webchat",
        SessionKey: sessionKey,
        MessageSid: "event-pre-adoption-custody",
        Body: "Process completed",
        BodyForAgent: "Process completed",
        InternalTurnSource: "event",
        InputProvenance: { kind: "internal_system", sourceTool: "exec" },
      }),
      cfg: emptyConfig,
      dispatcher: createDispatcher(),
      replyOptions: {
        abortSignal: abort.signal,
        onReplyOperationOwned,
        turnAdoptionLifecycle: { admission: "exclusive", onAdopted },
        internalEventExecution: { onStarted: vi.fn(), onTerminal: vi.fn() },
      },
      replyResolver,
    });
    let operation: ReplyOperation | undefined;
    try {
      const resolverOwner = await awaitGateBeforeSettlement(
        resolverEntered.promise,
        dispatch,
        "Dispatch settled before reaching the pre-adoption resolver",
      );
      operation = replyRunRegistry.get(sessionKey);
      expect(operation).toBeDefined();
      if (!operation?.ownerSettlement) {
        throw new Error("Dispatch did not retain its reply operation");
      }
      expect(resolverOwner).toBe(operation);
      expect(onReplyOperationOwned).toHaveBeenCalledExactlyOnceWith(operation);
      void operation.ownerSettlement.then(() => {
        ownerSettled = true;
      });
      abort.abort(new Error("Event producer cancelled"));
      await dispatch;

      expect(onAdopted).not.toHaveBeenCalled();
      expect(resolverFinished).toBe(false);
      expect(ownerSettled).toBe(false);
      expect(replyRunRegistry.get(sessionKey)).toBe(operation);
      releaseResolver.resolve();
      await operation.ownerSettlement;
      expect(resolverFinished).toBe(true);
      expect(ownerSettled).toBe(true);
      expect(replyRunRegistry.get(sessionKey)).toBeUndefined();
    } finally {
      releaseResolver.resolve();
      await dispatch;
      await operation?.ownerSettlement;
    }
  });

  it("retains inbound dedupe when durable ingress aborts after adoption", async () => {
    setNoAbort();
    const ctx = buildTestCtx({
      Provider: "telegram",
      Surface: "telegram",
      OriginatingChannel: "telegram",
      OriginatingTo: "user:1",
      SessionKey: "agent:main:telegram:direct:1",
      MessageSid: "post-adoption-abort",
      BodyForAgent: "run once",
    });
    const turnAdoptionLifecycle = {
      onAdopted: vi.fn(async () => {}),
      onDeferred: vi.fn(),
      onSettled: vi.fn(),
    };
    const firstReplyResolver = vi.fn(
      async (_ctx: MsgContext, opts?: GetReplyOptions): Promise<ReplyPayload | undefined> => {
        await opts?.turnAdoptionLifecycle?.onAdopted();
        const operation = (
          opts as { replyOperation?: { abortForRestart: () => boolean } } | undefined
        )?.replyOperation;
        expect(operation?.abortForRestart()).toBe(true);
        return await new Promise<never>(() => {});
      },
    );

    await dispatchReplyFromConfig({
      ctx,
      cfg: emptyConfig,
      dispatcher: createDispatcher(),
      replyOptions: { turnAdoptionLifecycle },
      replyResolver: firstReplyResolver,
    });
    expect(turnAdoptionLifecycle.onAdopted).toHaveBeenCalledOnce();

    const duplicateReplyResolver = vi.fn(
      async () => ({ text: "duplicate" }) satisfies ReplyPayload,
    );
    await dispatchReplyFromConfig({
      ctx,
      cfg: emptyConfig,
      dispatcher: createDispatcher(),
      replyOptions: { turnAdoptionLifecycle },
      replyResolver: duplicateReplyResolver,
    });
    expect(duplicateReplyResolver).not.toHaveBeenCalled();
  });
}
