// Exercises control-command reachability without relaxing ordinary reply admission.
import { afterEach, beforeAll, beforeEach, describe, expect, it, onTestFinished, vi } from "vitest";
import { createDeferred, raceWithTimeoutResult } from "../../../test/helpers/promise.js";
import type { OpenClawConfig } from "../../config/config.js";
import { markCommandReplyForDelivery } from "../reply-payload.js";
import {
  createDispatcher,
  setDiscordTestRegistry,
} from "./dispatch-from-config.shared.test-harness.js";
import {
  createReplyOperation,
  describe0BeforeEach0,
  dispatchReplyFromConfig,
  globalBeforeAll0,
  replyRunRegistry,
  setNoAbort,
} from "./dispatch-from-config.test-harness.js";
import { getActiveReplyRunCount } from "./reply-run-registry.registry.js";
import { buildTestCtx } from "./test-ctx.js";

beforeAll(globalBeforeAll0);
beforeEach(() => {
  describe0BeforeEach0();
  setDiscordTestRegistry();
  setNoAbort();
});
afterEach(() => vi.restoreAllMocks());

describe("dispatch active command admission", () => {
  it.each([
    { source: "text", body: "/think high", commandName: "think" },
    { source: "text", body: "/help", commandName: "help" },
    { source: "native", body: "/help", commandName: "help" },
    { source: "text", body: "/status", commandName: "status" },
    { source: "native", body: "/status", commandName: "status" },
  ] as const)(
    "delivers authorized $source $body while its session operation is active",
    async ({ source, body, commandName }) => {
      const sessionKey = "agent:main:command-reply-active";
      const activeOperation = createReplyOperation({
        sessionKey,
        sessionId: "active-session",
        resetTriggered: false,
      });
      activeOperation.setPhase("running");
      onTestFinished(() => activeOperation.complete());
      const waitingForActive = createDeferred<{ status: "waiting_for_active" }>();
      const waitForIdle = replyRunRegistry.waitForIdle.bind(replyRunRegistry);
      vi.spyOn(replyRunRegistry, "waitForIdle").mockImplementation((key, ...args) => {
        if (key === sessionKey) {
          waitingForActive.resolve({ status: "waiting_for_active" });
        }
        return waitForIdle(key, ...args);
      });

      const acknowledgement = { text: "Command completed." };
      const replyResolver = vi.fn(async () => markCommandReplyForDelivery(acknowledgement));
      const dispatcher = createDispatcher();
      const dispatchPromise = dispatchReplyFromConfig({
        ctx: buildTestCtx({
          CommandAuthorized: true,
          CommandSource: source,
          CommandTurn: {
            ...(source === "native"
              ? ({ kind: "native", source: "native" } as const)
              : ({ kind: "text-slash", source: "text" } as const)),
            authorized: true,
            commandName,
            body,
          },
          SessionKey: sessionKey,
          Body: body,
          RawBody: body,
          CommandBody: body,
          BodyForAgent: body,
        }),
        cfg: {
          diagnostics: { enabled: true },
          session: { sendPolicy: { default: "allow" } },
        } as OpenClawConfig,
        dispatcher,
        replyResolver,
      });

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
        expect(replyRunRegistry.get(sessionKey)).toBe(activeOperation);
      } finally {
        activeOperation.complete();
        await dispatchPromise;
      }
      expect(getActiveReplyRunCount()).toBe(0);
    },
  );

  it.each([
    { source: "text", body: "/bash echo unsafe", commandName: "bash", authorized: true },
    { source: "native", body: "/compact", commandName: "compact", authorized: true },
    { source: "text", body: "/reset", commandName: "reset", authorized: false },
    { source: "text", body: "/new", commandName: "new", authorized: false },
    { source: "text", body: "/help", commandName: "help", authorized: false },
    { source: "native", body: "/help", commandName: "help", authorized: false },
  ] as const)(
    "keeps $source $body (authorized=$authorized) behind active-session admission",
    async ({ source, body, commandName, authorized }) => {
      const sessionKey = "agent:main:executable-command-active";
      const activeOperation = createReplyOperation({
        sessionKey,
        sessionId: "active-session",
        resetTriggered: false,
      });
      activeOperation.setPhase("running");

      const callerAbort = new AbortController();
      const replyResolver = vi.fn(async () =>
        markCommandReplyForDelivery({ text: "Shell command completed." }),
      );
      const dispatchPromise = dispatchReplyFromConfig({
        ctx: buildTestCtx({
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
          SessionKey: sessionKey,
          Body: body,
          RawBody: body,
          CommandBody: body,
          BodyForAgent: body,
        }),
        cfg: {
          diagnostics: { enabled: true },
          session: { sendPolicy: { default: "allow" } },
        } as OpenClawConfig,
        dispatcher: createDispatcher(),
        replyOptions: { abortSignal: callerAbort.signal },
        replyResolver,
      });

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
      expect(getActiveReplyRunCount()).toBe(0);
    },
  );

  it.each([
    ["login", "/login cancel"],
    ["reset", "/reset"],
    ["new", "/new"],
    ["reset", "/reset continue"],
    ["new", "/new continue"],
  ])(
    "admits %s control (%s) past a pending command ticket while executable commands wait",
    async (controlName, controlBody) => {
      const sessionKey = "agent:main:login-ticket";
      const releaseLogin = createDeferred();
      const loginEntered = vi.fn();
      const controlEntered = vi.fn();
      const shellEntered = vi.fn();
      const dispatchCommand = (
        body: string,
        commandName: string,
        replyResolver: NonNullable<Parameters<typeof dispatchReplyFromConfig>[0]["replyResolver"]>,
      ) =>
        dispatchReplyFromConfig({
          ctx: buildTestCtx({
            Provider: "discord",
            Surface: "discord",
            CommandAuthorized: true,
            CommandSource: "text",
            CommandTurn: {
              kind: "text-slash",
              source: "text",
              authorized: true,
              commandName,
              body,
            },
            SessionKey: sessionKey,
            MessageSid: body,
            Body: body,
            RawBody: body,
            CommandBody: body,
            BodyForAgent: body,
          }),
          cfg: {
            diagnostics: { enabled: true },
            session: { sendPolicy: { default: "allow" } },
          },
          dispatcher: createDispatcher(),
          replyResolver,
        });
      const login = dispatchCommand("/login openrouter", "login", async () => {
        loginEntered();
        await releaseLogin.promise;
        return markCommandReplyForDelivery({ text: "Login ended." });
      });
      const pending = [login];
      try {
        await vi.waitFor(() => expect(loginEntered).toHaveBeenCalledOnce());
        const shell = dispatchCommand("/bash echo ready", "bash", async () => {
          shellEntered();
          return markCommandReplyForDelivery({ text: "Shell command completed." });
        });
        pending.push(shell);
        const control = dispatchCommand(controlBody, controlName, async () => {
          controlEntered();
          return markCommandReplyForDelivery({ text: "Control command completed." });
        });
        pending.push(control);

        await vi.waitFor(() => expect(controlEntered).toHaveBeenCalledOnce());
        expect(shellEntered).not.toHaveBeenCalled();
        expect(replyRunRegistry.isActive(sessionKey)).toBe(true);
        releaseLogin.resolve();
        await Promise.all(pending);
        expect(shellEntered).toHaveBeenCalledOnce();
        expect(getActiveReplyRunCount()).toBe(0);
      } finally {
        releaseLogin.resolve();
        await Promise.all(pending);
      }
    },
  );

  it("delivers a directive acknowledgement while its terminal path stays serialized", async () => {
    const sessionKey = "agent:main:directive-reply-active";
    const activeOperation = createReplyOperation({
      sessionKey,
      sessionId: "active-session",
      resetTriggered: false,
    });
    activeOperation.setPhase("running");

    const acknowledgement = { text: "Thinking level set to high.", isStatusNotice: true };
    const finalReply = { text: "The calculation is complete." };
    const dispatcher = createDispatcher();
    const dispatchPromise = dispatchReplyFromConfig({
      ctx: buildTestCtx({
        CommandAuthorized: true,
        CommandSource: "text",
        CommandTurn: {
          kind: "text-slash",
          source: "text",
          authorized: true,
          commandName: "think",
          body: "/think high",
        },
        SessionKey: sessionKey,
        Body: "/think high",
        RawBody: "/think high",
        CommandBody: "/think high",
        BodyForAgent: "/think high",
      }),
      cfg: {
        diagnostics: { enabled: true },
        session: { sendPolicy: { default: "allow" } },
      } as OpenClawConfig,
      dispatcher,
      replyResolver: async (_resolverCtx, options) => {
        await options?.onBlockReply?.(acknowledgement);
        return finalReply;
      },
    });

    try {
      await vi.waitFor(() => {
        expect(dispatcher.sendBlockReply).toHaveBeenCalledWith(acknowledgement);
      });
      expect(dispatcher.sendFinalReply).not.toHaveBeenCalled();
      expect(replyRunRegistry.get(sessionKey)).toBe(activeOperation);
      await expect(
        raceWithTimeoutResult(
          dispatchPromise.then(() => "settled" as const),
          100,
          "pending" as const,
        ),
      ).resolves.toBe("pending");
    } finally {
      activeOperation.complete();
    }
    await expect(dispatchPromise).resolves.toMatchObject({ queuedFinal: true });
    expect(dispatcher.sendFinalReply).toHaveBeenCalledExactlyOnceWith(finalReply);
    expect(getActiveReplyRunCount()).toBe(0);
  });

  it("admits authorized native /status on the source while the target has an active run", async () => {
    const sourceSessionKey = "agent:main:telegram:slash:user-auth";
    const targetSessionKey = "agent:main:telegram:group:status-target";
    const targetOperation = createReplyOperation({
      sessionKey: targetSessionKey,
      sessionId: "status-target-active-session",
      resetTriggered: false,
    });
    targetOperation.setPhase("running");

    const replyResolver = vi.fn(async () => ({
      text: "🧠 Model: mock | ⚙️ Status: ok",
    }));
    const dispatcher = createDispatcher();
    const ctx = buildTestCtx({
      Provider: "telegram",
      Surface: "telegram",
      CommandSource: "native",
      CommandAuthorized: true,
      CommandTurn: {
        kind: "native",
        source: "native",
        authorized: true,
        commandName: "status",
        body: "/status",
      },
      SessionKey: sourceSessionKey,
      CommandTargetSessionKey: targetSessionKey,
      Body: "/status",
      RawBody: "/status",
      CommandBody: "/status",
      BodyForAgent: "/status",
    });

    const dispatchPromise = dispatchReplyFromConfig({
      ctx,
      cfg: {
        diagnostics: { enabled: true },
        session: {
          sendPolicy: { default: "allow" },
        },
      } as OpenClawConfig,
      dispatcher,
      replyResolver,
    });

    type DispatchOutcome =
      | { status: "settled"; result: Awaited<typeof dispatchPromise> }
      | { status: "pending" };
    const outcome = await raceWithTimeoutResult<DispatchOutcome>(
      dispatchPromise.then((result) => ({ status: "settled" as const, result })),
      200,
      { status: "pending" as const },
    );
    expect(outcome).toMatchObject({
      status: "settled",
      result: {
        queuedFinal: true,
      },
    });
    expect(replyResolver).toHaveBeenCalledOnce();
    expect(dispatcher.sendFinalReply).toHaveBeenCalledWith({
      text: "🧠 Model: mock | ⚙️ Status: ok",
    });
    expect(targetOperation.result).toBeNull();
    expect(replyRunRegistry.get(targetSessionKey)).toBe(targetOperation);
    targetOperation.complete();
    expect(getActiveReplyRunCount()).toBe(0);
  });
});
