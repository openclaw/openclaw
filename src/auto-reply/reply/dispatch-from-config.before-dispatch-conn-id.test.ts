import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  createDispatcher,
  emptyConfig,
  hookMocks,
} from "./dispatch-from-config.shared.test-harness.js";
import {
  describe0BeforeEach0,
  dispatchReplyFromConfig,
  globalBeforeAll0,
  setNoAbort,
} from "./dispatch-from-config.test-support.js";
import { resetInboundDedupe } from "./inbound-dedupe.js";
import { buildTestCtx } from "./test-ctx.js";

beforeAll(globalBeforeAll0);

describe("before_dispatch connection correlation", () => {
  beforeEach(() => {
    describe0BeforeEach0();
    setNoAbort();
    hookMocks.runner.hasHooks.mockImplementation(
      (hookName?: string) => hookName === "before_dispatch",
    );
  });

  afterEach(() => {
    resetInboundDedupe();
  });

  async function runAndReadHookContext(
    overrides: Parameters<typeof buildTestCtx>[0],
  ): Promise<Record<string, unknown>> {
    await dispatchReplyFromConfig({
      ctx: buildTestCtx({
        Body: "hello",
        Provider: "telegram",
        Surface: "telegram",
        ChatType: "direct",
        From: "user1",
        To: "telegram:2000",
        SessionKey: "agent:main:session",
        MessageSid: "before-dispatch-conn-id",
        ...overrides,
      }),
      cfg: emptyConfig,
      dispatcher: createDispatcher(),
      replyResolver: async () => ({ text: "core reply" }),
    });

    const call = hookMocks.runner.runBeforeDispatch.mock.calls.at(-1);
    if (!call) {
      throw new Error("expected before_dispatch to run");
    }
    return call[1] as Record<string, unknown>;
  }

  it.each(["control-ui-conn-42", "control-ui-conn-43"])(
    "passes the originating Control UI connection %s",
    async (connId) => {
      const context = await runAndReadHookContext({
        GatewayUiCommandTarget: { connId },
      });

      expect(context.connId).toBe(connId);
    },
  );

  it("omits the connection for channel-originated turns", async () => {
    const context = await runAndReadHookContext({});

    expect(context).not.toHaveProperty("connId");
  });
});
