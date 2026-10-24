import { afterEach, beforeAll, beforeEach, expect, it, onTestFinished, vi } from "vitest";
import {
  awaitGateBeforeSettlement,
  createDeferred,
  raceWithTimeoutResult,
  withinTest,
} from "../../../test/helpers/promise.js";
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

type Resolver = NonNullable<DispatchFromConfigParams["replyResolver"]>;
beforeAll(globalBeforeAll0);
beforeEach(() => {
  describe0BeforeEach0();
  setDiscordTestRegistry();
  setNoAbort();
});
afterEach(() => vi.restoreAllMocks());

function commandFixture(source: "text" | "native", target: boolean) {
  const key = target
    ? "agent:main:telegram:group:status-target"
    : "agent:main:command-reply-active";
  const sourceKey = target ? "agent:main:telegram:slash:user-auth" : key;
  const pending: ReturnType<typeof dispatchReplyFromConfig>[] = [];
  const start = (
    body: string,
    replyResolver: Resolver,
    overrides: Partial<MsgContext> = {},
    replyOptions?: DispatchFromConfigParams["replyOptions"],
  ) => {
    const dispatcher = createDispatcher();
    const authorized = overrides.CommandAuthorized ?? true;
    const commandName = body.slice(1).split(" ")[0];
    const ctx = buildTestCtx({
      CommandSource: source,
      CommandAuthorized: authorized,
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
      SessionKey: sourceKey,
      ...(target
        ? { Provider: "telegram", Surface: "telegram", CommandTargetSessionKey: key }
        : {}),
      ...overrides,
    });
    const work = dispatchReplyFromConfig({
      ctx,
      dispatcher,
      replyResolver,
      replyOptions,
      cfg: { diagnostics: { enabled: true }, session: { sendPolicy: { default: "allow" } } },
    });
    pending.push(work);
    return { work, dispatcher };
  };
  return {
    key,
    sourceKey,
    start,
    close: async () => {
      await Promise.all(pending);
      expect(listActiveReplyRunSessionKeys()).toEqual([]);
    },
  };
}

async function withActive(
  source: "text" | "native",
  target: boolean,
  run: (
    fixture: ReturnType<typeof commandFixture> & {
      operation: ReturnType<typeof createReplyOperation>;
    },
  ) => Promise<void>,
) {
  const fixture = commandFixture(source, target);
  const operation = createReplyOperation({
    sessionKey: fixture.key,
    sessionId: target ? "status-target-active-session" : "active-session",
    resetTriggered: false,
  });
  operation.setPhase("running");
  onTestFinished(() => operation.complete());
  try {
    await run({ ...fixture, operation });
  } finally {
    operation.complete();
    await fixture.close();
  }
}

it.each([
  ["text", "/status", true, false],
  ["native", "/status", true, false],
  ["native", "/status", true, true],
  ["native", "/compact", true, false],
  ["native", "/help", false, false],
] as const)("admits %s %s (authorized=%s, target=%s)", async (source, body, authorized, target) => {
  await withActive(source, target, async ({ key, sourceKey, operation, start }) => {
    const waiting = createDeferred<{ status: "waiting_for_active" }>();
    const wait = controllerWait.waitForSessionRunIdle;
    vi.spyOn(controllerWait, "waitForSessionRunIdle").mockImplementation((sessionKey, ...args) => {
      if (sessionKey === key) {
        waiting.resolve({ status: "waiting_for_active" });
      }
      return wait(sessionKey, ...args);
    });
    const acknowledgement = {
      text: target ? "🧠 Model: mock | ⚙️ Status: ok" : "Command completed.",
    };
    const resolver = vi.fn<Resolver>(async (_ctx, options) => {
      const binding = readReplySourceInput(options);
      if (target) {
        expect(binding?.mailbox.owner.aliases.has(sourceKey)).toBe(true);
      }
      if (target || body !== "/status") {
        expect(options?.replyOperation).toBeUndefined();
        expect(binding?.claim).toBeUndefined();
      }
      return target ? acknowledgement : markCommandReplyForDelivery(acknowledgement);
    });
    const { work, dispatcher } = start(body, resolver, { CommandAuthorized: authorized });
    expect(
      await Promise.race([work.then((result) => ({ status: "settled", result })), waiting.promise]),
    ).toMatchObject({ status: "settled", result: { queuedFinal: true } });
    expect(resolver).toHaveBeenCalledOnce();
    expect(dispatcher.sendFinalReply).toHaveBeenCalledWith(acknowledgement);
    expect(getSessionControllerOperation(key)).toBe(operation);
    expect(operation.result).toBeNull();
  });
});

it.each([
  ["/bash echo unsafe", true],
  ["/reset", false],
] as const)("blocks %s behind active admission (authorized=%s)", async (body, authorized) => {
  const resolver = vi.fn(async () =>
    markCommandReplyForDelivery({ text: "Shell command completed." }),
  );
  await withActive("text", false, async ({ start }) => {
    const abort = new AbortController();
    const { work } = start(
      body,
      resolver,
      { CommandAuthorized: authorized },
      { abortSignal: abort.signal },
    );
    try {
      await expect(
        raceWithTimeoutResult(
          work.then(() => "settled" as const),
          100,
          "pending" as const,
        ),
      ).resolves.toBe("pending");
      expect(resolver).not.toHaveBeenCalled();
    } finally {
      abort.abort();
    }
  });
  expect(resolver).not.toHaveBeenCalled();
});

it.each(["/login cancel", "/reset", "/new continue"])(
  "admits %s past a command ticket while executable commands wait",
  async (body) => {
    const { key, start, close } = commandFixture("text", false);
    const release = createDeferred();
    const loginStarted = createDeferred();
    const controlStarted = createDeferred();
    const loginEntered = vi.fn();
    const controlEntered = vi.fn();
    const shellEntered = vi.fn();
    const dispatch = (command: string, resolver: Resolver) =>
      start(command, resolver, {
        Provider: "discord",
        Surface: "discord",
        MessageSid: command,
      }).work;
    const login = dispatch("/login openrouter", async () => {
      loginEntered();
      loginStarted.resolve();
      await release.promise;
      return markCommandReplyForDelivery({ text: "Login ended." });
    });
    try {
      await awaitGateBeforeSettlement(
        loginStarted.promise,
        login,
        "login settled before its resolver",
      );
      expect(loginEntered).toHaveBeenCalledOnce();
      void dispatch("/bash echo ready", async () => {
        shellEntered();
        return markCommandReplyForDelivery({ text: "Shell command completed." });
      });
      const control = dispatch(body, async () => {
        controlEntered();
        controlStarted.resolve();
        return markCommandReplyForDelivery({ text: "Control command completed." });
      });
      await awaitGateBeforeSettlement(
        controlStarted.promise,
        control,
        "control settled before its resolver",
      );
      expect(controlEntered).toHaveBeenCalledOnce();
      expect(shellEntered).not.toHaveBeenCalled();
      expect(isSessionRunActiveForKey(key)).toBe(true);
    } finally {
      release.resolve();
      await close();
    }
    expect(shellEntered).toHaveBeenCalledOnce();
  },
);

it("lets text /steer reach queue policy beside its active turn", async ({ signal }) => {
  await withActive("text", false, async ({ key, operation, start }) => {
    const reached = createDeferred<boolean>();
    start("/steer use the corrected approach", async () => {
      reached.resolve(operation.result === null);
      return undefined;
    });
    expect(await withinTest(reached.promise, signal)).toBe(true);
    expect(getSessionControllerOperation(key)).toBe(operation);
  });
});

it("delivers directive output without claiming the active turn", async () => {
  await withActive("text", false, async ({ key, operation, start }) => {
    const block = { text: "Thinking level set to high.", isStatusNotice: true };
    const final = { text: "The calculation is complete." };
    const { work, dispatcher } = start("/think high", async (_ctx, options) => {
      await options?.onBlockReply?.(block);
      return final;
    });
    await vi.waitFor(() => expect(dispatcher.sendBlockReply).toHaveBeenCalledWith(block));
    await expect(work).resolves.toMatchObject({ queuedFinal: true });
    expect(dispatcher.sendFinalReply).toHaveBeenCalledExactlyOnceWith(final);
    expect(getSessionControllerOperation(key)).toBe(operation);
    expect(operation.result).toBeNull();
  });
});
