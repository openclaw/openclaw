import { beforeEach, expect, it, vi } from "vitest";
import { deliverAgentCommandResult } from "../agents/command/delivery.js";
import type { ReplyPayload } from "../auto-reply/types.js";
import type { RuntimeEnv } from "../runtime.js";
import { normalizeSessionDeliveryState } from "../utils/delivery-context.shared.js";
import { createTestRuntime } from "./test-runtime-config-helpers.js";

const mocks = vi.hoisted(() => ({
  deliverOutboundPayloads: vi.fn(async (_params: DeliveryCall) => []),
  getChannelPlugin: vi.fn(() => ({ outbound: { deliveryMode: "gateway" } })),
  resolveOutboundTarget: vi.fn(
    (_params: { channel?: string; to?: string; accountId?: string }) => ({
      ok: true as const,
      to: "+15551234567",
    }),
  ),
}));

type DeliveryCall = {
  session?: { agentId?: string; key?: string };
};

function onlyCall<T>(mock: { mock: { calls: [T][] } }): T {
  expect(mock).toHaveBeenCalledOnce();
  return mock.mock.calls[0]?.[0] ?? expect.fail("Expected call");
}

vi.mock("../channels/plugins/index.js", () => ({
  getChannelPlugin: mocks.getChannelPlugin,
  getLoadedChannelPlugin: mocks.getChannelPlugin,
  normalizeChannelId: (value: string) => value,
}));

vi.mock("../infra/outbound/deliver.js", () => ({
  deliverOutboundPayloads: mocks.deliverOutboundPayloads,
  deliverOutboundPayloadsInternal: mocks.deliverOutboundPayloads,
}));

vi.mock("../infra/outbound/targets.js", async () => {
  const actual = await vi.importActual<typeof import("../infra/outbound/targets.js")>(
    "../infra/outbound/targets.js",
  );
  return {
    ...actual,
    resolveOutboundTarget: mocks.resolveOutboundTarget,
  };
});

async function runDelivery(params: {
  opts?: Partial<Parameters<typeof deliverAgentCommandResult>[0]["opts"]>;
  outboundSession?: { key?: string; agentId?: string };
  sessionEntry?: Parameters<typeof deliverAgentCommandResult>[0]["sessionEntry"];
  runtime?: RuntimeEnv;
  resultText?: string;
  payloads?: ReplyPayload[];
}) {
  const runtime = params.runtime ?? createTestRuntime();
  const payloads = params.payloads ?? [{ text: params.resultText ?? "hi" }];
  const deliveryResult = await deliverAgentCommandResult({
    cfg: {},
    deps: {},
    runtime,
    opts: { message: "hello", ...params.opts },
    outboundSession: params.outboundSession,
    sessionEntry: params.sessionEntry,
    result: { payloads, meta: { durationMs: 1 } },
    payloads,
  });

  return { runtime, deliveryResult };
}

beforeEach(() => {
  mocks.deliverOutboundPayloads.mockClear();
  mocks.resolveOutboundTarget.mockClear();
});

it("stays silent for intentional empty payloads", async () => {
  const { runtime } = await runDelivery({ payloads: [] });
  expect(runtime.log).not.toHaveBeenCalled();
  expect(mocks.deliverOutboundPayloads).not.toHaveBeenCalled();
});

it.each([
  ["+15559876543", "work"],
  [undefined, undefined],
])(
  "uses turn destination %s and caller session instead of stale session routing",
  async (to, accountId) => {
    const outboundSession = { key: "agent:exec:hook:gmail:thread-1", agentId: "exec" };
    await runDelivery({
      opts: {
        deliver: true,
        runContext: { messageChannel: "whatsapp", currentChannelId: to, accountId },
      },
      outboundSession,
      sessionEntry: {
        sessionId: "fixture",
        updatedAt: 1,
        delivery: normalizeSessionDeliveryState({
          context: { channel: "slack", to: "U_WRONG", accountId: "wrong" },
        }),
      },
    });
    expect(mocks.resolveOutboundTarget).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        channel: "whatsapp",
        to,
        ...(accountId ? { accountId } : {}),
      }),
    );
    expect(onlyCall(mocks.deliverOutboundPayloads).session).toMatchObject(outboundSession);
  },
);

it.each(["nested", "nested:agent:main:child"])(
  "retains %s replies without logging them",
  async (lane) => {
    const { runtime, deliveryResult } = await runDelivery({
      resultText: "Private child reply\nsecond private line",
      opts: {
        deliver: false,
        lane,
        sessionKey: "agent:ebao-next:quietchat:channel:1",
        runId: "run-announce",
        messageChannel: "webchat",
      },
    });

    expect(deliveryResult.payloads).toEqual([
      expect.objectContaining({ text: "Private child reply\nsecond private line" }),
    ]);
    expect(runtime.log).not.toHaveBeenCalled();
  },
);

it("prints interactive CLI replies through the output writer", async () => {
  const runtime = { ...createTestRuntime(), writeStdout: vi.fn(), writeJson: vi.fn() };
  const { deliveryResult } = await runDelivery({ runtime, resultText: "CLI reply" });

  expect(deliveryResult.payloads).toEqual([expect.objectContaining({ text: "CLI reply" })]);
  expect(runtime.writeStdout).toHaveBeenCalledWith("CLI reply");
  expect(runtime.log).not.toHaveBeenCalled();
});
