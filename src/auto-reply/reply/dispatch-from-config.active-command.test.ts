// Exercises control-command reachability without relaxing ordinary reply admission.
import { afterEach, beforeAll, beforeEach, describe, expect, it, onTestFinished, vi } from "vitest";
import {
  awaitGateBeforeSettlement,
  createDeferred,
  raceWithTimeoutResult,
  withinTest,
} from "../../../test/helpers/promise.js";
import type { OpenClawConfig } from "../../config/config.js";
import { listActiveReplyRunSessionKeys } from "../../sessions/session-controller.queries.js";
import * as controllerWait from "../../sessions/session-controller.wait.js";
import { markCommandReplyForDelivery } from "../reply-payload.js";
import type { MsgContext } from "../templating.js";
import {
  createDispatcher,
  setDiscordTestRegistry,
} from "./dispatch-from-config.shared.test-harness.js";
import {
  createReplyOperation,
  describe0BeforeEach0,
  dispatchReplyFromConfig,
  globalBeforeAll0,
  setNoAbort,
  getSessionControllerOperation,
  isSessionRunActiveForKey,
} from "./dispatch-from-config.test-support.js";
import type { DispatchFromConfigParams } from "./dispatch-from-config.types.js";
import { readReplySourceInput } from "./reply-source-binding.js";
import { buildTestCtx } from "./test-ctx.js";

beforeAll(globalBeforeAll0);
beforeEach(() => {
  describe0BeforeEach0();
  setDiscordTestRegistry();
  setNoAbort();
});
afterEach(() => vi.restoreAllMocks());

const cfg: OpenClawConfig = {
  diagnostics: { enabled: true },
  session: { sendPolicy: { default: "allow" } },
};

function commandContext(
  source: "text" | "native",
  body: string,
  commandName: string,
  overrides: Partial<MsgContext>,
) {
  const authorized = overrides.CommandAuthorized ?? true;
  return buildTestCtx({
    CommandAuthorized: authorized,
    CommandSource: source,
    CommandTurn: {
      ...(source === "native"
        ? ({ kind: "native", source: "native" } as const)
        : ({ kind: "text-slash", source: "text" } as const)),
      authorized,
      commandName,
      body,
    },
    Body: body,
    RawBody: body,
    CommandBody: body,
    BodyForAgent: body,
    ...overrides,
  });
}

function startOperation(sessionKey: string, sessionId = "active-session") {
  const operation = createReplyOperation({ sessionKey, sessionId, resetTriggered: false });
  operation.setPhase("running");
  return operation;
}

function dispatchCommand(
  ctx: MsgContext,
  replyResolver: NonNullable<DispatchFromConfigParams["replyResolver"]>,
  dispatcher = createDispatcher(),
  replyOptions?: DispatchFromConfigParams["replyOptions"],
) {
  return dispatchReplyFromConfig({
    ctx,
    cfg: structuredClone(cfg),
    dispatcher,
    replyResolver,
    replyOptions,
  });
}

describe("dispatch active command admission", () => {
  it.each([
    { source: "text", target: false },
    { source: "native", target: false },
    { source: "native", target: true },
  ] as const)(
    "delivers authorized $source /status beside an active operation (separate target: $target)",
    async ({ source, target }) => {
      const sessionKey = target
        ? "agent:main:telegram:group:status-target"
        : "agent:main:command-reply-active";
      const sourceSessionKey = target ? "agent:main:telegram:slash:user-auth" : sessionKey;
      const activeOperation = startOperation(
        sessionKey,
        target ? "status-target-active-session" : undefined,
      );
      onTestFinished(() => activeOperation.complete());
      const waitingForActive = createDeferred<{ status: "waiting_for_active" }>();
      const waitForIdle = controllerWait.waitForSessionRunIdle;
      vi.spyOn(controllerWait, "waitForSessionRunIdle").mockImplementation((key, ...args) => {
        if (key === sessionKey) {
          waitingForActive.resolve({ status: "waiting_for_active" });
        }
        return waitForIdle(key, ...args);
      });

      const acknowledgement = {
        text: target ? "🧠 Model: mock | ⚙️ Status: ok" : "Command completed.",
      };
      const replyResolver = vi.fn<NonNullable<DispatchFromConfigParams["replyResolver"]>>(
        async (_ctx, options) => {
          if (target) {
            const sourceBinding = readReplySourceInput(options);
            expect(sourceBinding?.mailbox.owner.aliases.has(sourceSessionKey)).toBe(true);
            expect(sourceBinding?.claim).toBeUndefined();
            expect(options?.replyOperation).toBeUndefined();
          }
          return target ? acknowledgement : markCommandReplyForDelivery(acknowledgement);
        },
      );
      const dispatcher = createDispatcher();
      const dispatchPromise = dispatchCommand(
        commandContext(source, "/status", "status", {
          SessionKey: sourceSessionKey,
          ...(target
            ? { Provider: "telegram", Surface: "telegram", CommandTargetSessionKey: sessionKey }
            : {}),
        }),
        replyResolver,
        dispatcher,
      );

      try {
        const outcome = await Promise.race([
          dispatchPromise.then((result) => ({ status: "settled" as const, result })),
          waitingForActive.promise,
        ]);

        expect(outcome).toMatchObject({
          status: "settled",
          result: { queuedFinal: true },
        });
        expect(replyResolver).toHaveBeenCalledOnce();
        expect(dispatcher.sendFinalReply).toHaveBeenCalledWith(acknowledgement);
        expect(getSessionControllerOperation(sessionKey)).toBe(activeOperation);
        expect(activeOperation.result).toBeNull();
      } finally {
        activeOperation.complete();
        await dispatchPromise;
      }
      expect(listActiveReplyRunSessionKeys()).toEqual([]);
    },
  );

  it.each([
    { source: "text", body: "/bash echo unsafe", commandName: "bash", authorized: true },
    { source: "text", body: "/reset", commandName: "reset", authorized: false },
  ] as const)(
    "keeps $source $body (authorized=$authorized) behind active-session admission",
    async ({ source, body, commandName, authorized }) => {
      const sessionKey = "agent:main:executable-command-active";
      const activeOperation = startOperation(sessionKey);

      const callerAbort = new AbortController();
      const replyResolver = vi.fn(async () =>
        markCommandReplyForDelivery({ text: "Shell command completed." }),
      );
      const dispatchPromise = dispatchCommand(
        commandContext(source, body, commandName, {
          CommandAuthorized: authorized,
          SessionKey: sessionKey,
        }),
        replyResolver,
        undefined,
        { abortSignal: callerAbort.signal },
      );

      try {
        await expect(
          raceWithTimeoutResult(
            dispatchPromise.then(() => "settled" as const),
            100,
            "pending" as const,
          ),
        ).resolves.toBe("pending");
        expect(replyResolver).not.toHaveBeenCalled();
      } finally {
        callerAbort.abort();
        activeOperation.complete();
      }
      await dispatchPromise;
      expect(replyResolver).not.toHaveBeenCalled();
      expect(listActiveReplyRunSessionKeys()).toEqual([]);
    },
  );

  it.each([
    { body: "/compact", commandName: "compact", authorized: true },
    { body: "/help", commandName: "help", authorized: false },
  ])(
    "reaches the native $commandName owner without borrowing an active turn",
    async ({ body, commandName, authorized }) => {
      const sessionKey = "agent:main:native-handler-boundary";
      const active = startOperation(sessionKey);
      onTestFinished(() => active.complete());
      const replyResolver = vi.fn<NonNullable<DispatchFromConfigParams["replyResolver"]>>(
        async (_ctx, options) => {
          expect(options?.replyOperation).toBeUndefined();
          expect(readReplySourceInput(options)?.claim).toBeUndefined();
          // Authorization and a command-specific mutation claim belong to the
          // native handler, not the mailbox slot of the turn it controls.
          return markCommandReplyForDelivery({ text: "handled" });
        },
      );
      await dispatchCommand(
        commandContext("native", body, commandName, {
          CommandAuthorized: authorized,
          SessionKey: sessionKey,
        }),
        replyResolver,
      );
      expect(replyResolver).toHaveBeenCalledOnce();
      expect(active.result).toBeNull();
    },
  );

  it.each([
    ["login", "/login cancel"],
    ["reset", "/reset"],
    ["new", "/new continue"],
  ])(
    "admits %s control (%s) past a pending command ticket while executable commands wait",
    async (controlName, controlBody) => {
      const sessionKey = "agent:main:login-ticket";
      const releaseLogin = createDeferred();
      const loginStarted = createDeferred();
      const controlStarted = createDeferred();
      const loginEntered = vi.fn();
      const controlEntered = vi.fn();
      const shellEntered = vi.fn();
      const dispatch = (
        body: string,
        commandName: string,
        replyResolver: NonNullable<Parameters<typeof dispatchReplyFromConfig>[0]["replyResolver"]>,
      ) =>
        dispatchCommand(
          commandContext("text", body, commandName, {
            Provider: "discord",
            Surface: "discord",
            SessionKey: sessionKey,
            MessageSid: body,
          }),
          replyResolver,
        );
      const login = dispatch("/login openrouter", "login", async () => {
        loginEntered();
        loginStarted.resolve();
        await releaseLogin.promise;
        return markCommandReplyForDelivery({ text: "Login ended." });
      });
      const pending = [login];
      try {
        await awaitGateBeforeSettlement(
          loginStarted.promise,
          login,
          "login dispatch settled before entering its reply resolver",
        );
        expect(loginEntered).toHaveBeenCalledOnce();
        const shell = dispatch("/bash echo ready", "bash", async () => {
          shellEntered();
          return markCommandReplyForDelivery({ text: "Shell command completed." });
        });
        pending.push(shell);
        const control = dispatch(controlBody, controlName, async () => {
          controlEntered();
          controlStarted.resolve();
          return markCommandReplyForDelivery({ text: "Control command completed." });
        });
        pending.push(control);

        await awaitGateBeforeSettlement(
          controlStarted.promise,
          control,
          "control dispatch settled before entering its reply resolver",
        );
        expect(controlEntered).toHaveBeenCalledOnce();
        expect(shellEntered).not.toHaveBeenCalled();
        expect(isSessionRunActiveForKey(sessionKey)).toBe(true);
        releaseLogin.resolve();
        await Promise.all(pending);
        expect(shellEntered).toHaveBeenCalledOnce();
        expect(listActiveReplyRunSessionKeys()).toEqual([]);
      } finally {
        releaseLogin.resolve();
        await Promise.all(pending);
      }
    },
  );

  it("lets an authorized text /steer reach queue policy beside the turn it steers", async ({
    signal,
  }) => {
    const sessionKey = "agent:main:steer-active";
    const activeOperation = startOperation(sessionKey);
    onTestFinished(() => activeOperation.complete());
    const reachedWhileActive = createDeferred<boolean>();
    const replyResolver = vi.fn<NonNullable<DispatchFromConfigParams["replyResolver"]>>(
      async () => {
        reachedWhileActive.resolve(activeOperation.result === null);
        return undefined;
      },
    );
    const dispatchPromise = dispatchCommand(
      commandContext("text", "/steer use the corrected approach", "steer", {
        SessionKey: sessionKey,
      }),
      replyResolver,
    );

    try {
      expect(await withinTest(reachedWhileActive.promise, signal)).toBe(true);
      expect(getSessionControllerOperation(sessionKey)).toBe(activeOperation);
    } finally {
      activeOperation.complete();
      await dispatchPromise;
    }
  });

  it("delivers directive control output without claiming the active target turn", async () => {
    const sessionKey = "agent:main:directive-reply-active";
    const activeOperation = startOperation(sessionKey);

    const acknowledgement = { text: "Thinking level set to high.", isStatusNotice: true };
    const finalReply = { text: "The calculation is complete." };
    const dispatcher = createDispatcher();
    const dispatchPromise = dispatchCommand(
      commandContext("text", "/think high", "think", {
        SessionKey: sessionKey,
      }),
      async (_resolverCtx, options) => {
        await options?.onBlockReply?.(acknowledgement);
        return finalReply;
      },
      dispatcher,
    );

    try {
      await vi.waitFor(() => {
        expect(dispatcher.sendBlockReply).toHaveBeenCalledWith(acknowledgement);
      });
      await expect(dispatchPromise).resolves.toMatchObject({ queuedFinal: true });
      expect(dispatcher.sendFinalReply).toHaveBeenCalledExactlyOnceWith(finalReply);
      expect(getSessionControllerOperation(sessionKey)).toBe(activeOperation);
      expect(activeOperation.result).toBeNull();
    } finally {
      activeOperation.complete();
    }
    expect(listActiveReplyRunSessionKeys()).toEqual([]);
  });
});
