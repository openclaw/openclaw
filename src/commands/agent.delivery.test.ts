import { beforeEach, describe, expect, it, vi } from "vitest";
import { deliverAgentCommandResult } from "../agents/command/delivery.js";
import type { ReplyPayload } from "../auto-reply/types.js";
import type { SessionEntry } from "../config/sessions.js";
import type { RuntimeEnv } from "../runtime.js";
import { normalizeSessionDeliveryState } from "../utils/delivery-context.shared.js";
import type { DeliveryContext } from "../utils/delivery-context.types.js";
import { createTestRuntime } from "./test-runtime-config-helpers.js";

const mocks = vi.hoisted(() => ({
  deliverOutboundPayloads: vi.fn(async (_params: DeliveryCall) => []),
  getChannelPlugin: vi.fn(() => ({ outbound: { deliveryMode: "gateway" } })),
  resolveOutboundTarget: vi.fn((_params: ResolveTargetCall) => ({
    ok: true as const,
    to: "+15551234567",
  })),
}));

type DeliveryCall = {
  session?: { agentId?: string; key?: string };
};

type ResolveTargetCall = {
  accountId?: string;
  channel?: string;
  to?: string;
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

describe("deliverAgentCommandResult", () => {
  function sessionEntry(context: DeliveryContext): SessionEntry {
    return {
      sessionId: "fixture",
      updatedAt: 1,
      delivery: normalizeSessionDeliveryState({ context }),
    };
  }

  async function runDelivery(params: {
    opts?: Partial<Parameters<typeof deliverAgentCommandResult>[0]["opts"]>;
    outboundSession?: { key?: string; agentId?: string };
    sessionEntry?: SessionEntry;
    runtime?: RuntimeEnv;
    resultText?: string;
    payloads?: ReplyPayload[];
  }) {
    const runtime = params.runtime ?? createTestRuntime();
    const result = {
      payloads: params.payloads ?? [{ text: params.resultText ?? "hi" }],
      meta: { durationMs: 1 },
    };

    const deliveryResult = await deliverAgentCommandResult({
      cfg: {},
      deps: {},
      runtime,
      opts: { message: "hello", ...params.opts },
      outboundSession: params.outboundSession,
      sessionEntry: params.sessionEntry,
      result,
      payloads: result.payloads,
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
    ["uses turn source over stale session route", "+15559876543", "work"],
    [
      "does not reuse session lastTo when the turn source omits currentChannelId",
      undefined,
      undefined,
    ],
  ])("%s", async (_label, to, accountId) => {
    await runDelivery({
      opts: {
        deliver: true,
        runContext: {
          messageChannel: "whatsapp",
          currentChannelId: to,
          accountId,
        },
      },
      sessionEntry: sessionEntry({ channel: "slack", to: "U_WRONG", accountId: "wrong" }),
    });

    expect(onlyCall(mocks.resolveOutboundTarget)).toMatchObject({
      channel: "whatsapp",
      to,
      ...(accountId ? { accountId } : {}),
    });
  });

  it("uses caller-provided outbound session context when opts.sessionKey is absent", async () => {
    await runDelivery({
      opts: { deliver: true, channel: "whatsapp", to: "+15551234567" },
      outboundSession: { key: "agent:exec:hook:gmail:thread-1", agentId: "exec" },
    });

    expect(onlyCall(mocks.deliverOutboundPayloads).session).toMatchObject({
      key: "agent:exec:hook:gmail:thread-1",
      agentId: "exec",
    });
  });

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
});
