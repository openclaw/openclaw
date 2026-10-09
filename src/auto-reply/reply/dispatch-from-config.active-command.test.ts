// Exercises control-command reachability without relaxing ordinary reply admission.
import { afterEach, beforeAll, beforeEach, describe, expect, it, onTestFinished, vi } from "vitest";
import { createDeferred, raceWithTimeoutResult } from "../../../test/helpers/promise.js";
import type { OpenClawConfig } from "../../config/config.js";
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
      const waitForIdle = replyRunRegistry.waitForIdle.bind(replyRunRegistry);
      vi.spyOn(replyRunRegistry, "waitForIdle").mockImplementation((key, ...args) => {
        if (key === sessionKey) {
          waitingForActive.resolve({ status: "waiting_for_active" });
        }
        return waitForIdle(key, ...args);
      });

      const acknowledgement = {
        text: target ? "🧠 Model: mock | ⚙️ Status: ok" : "Command completed.",
      };
      const replyResolver = vi.fn(async () =>
        target ? acknowledgement : markCommandReplyForDelivery(acknowledgement),
      );
      const dispatcher = createDispatcher();
      const dispatchPromise = dispatchReplyFromConfig({
        ctx: commandContext(source, "/status", "status", {
          SessionKey: sourceSessionKey,
          ...(target
            ? { Provider: "telegram", Surface: "telegram", CommandTargetSessionKey: sessionKey }
            : {}),
        }),
        cfg: structuredClone(cfg),
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
        if (target) {
          expect(activeOperation.result).toBeNull();
        }
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
    { source: "native", body: "/help", commandName: "help", authorized: false },
  ] as const)(
    "keeps $source $body (authorized=$authorized) behind active-session admission",
    async ({ source, body, commandName, authorized }) => {
      const sessionKey = "agent:main:executable-command-active";
      const activeOperation = startOperation(sessionKey);

      const callerAbort = new AbortController();
      const replyResolver = vi.fn(async () =>
        markCommandReplyForDelivery({ text: "Shell command completed." }),
      );
      const dispatchPromise = dispatchReplyFromConfig({
        ctx: commandContext(source, body, commandName, {
          CommandAuthorized: authorized,
          SessionKey: sessionKey,
        }),
        cfg: structuredClone(cfg),
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
          ctx: commandContext("text", body, commandName, {
            Provider: "discord",
            Surface: "discord",
            SessionKey: sessionKey,
            MessageSid: body,
          }),
          cfg: structuredClone(cfg),
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
    const activeOperation = startOperation(sessionKey);

    const acknowledgement = { text: "Thinking level set to high.", isStatusNotice: true };
    const finalReply = { text: "The calculation is complete." };
    const dispatcher = createDispatcher();
    const dispatchPromise = dispatchReplyFromConfig({
      ctx: commandContext("text", "/think high", "think", {
        SessionKey: sessionKey,
      }),
      cfg: structuredClone(cfg),
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
});
