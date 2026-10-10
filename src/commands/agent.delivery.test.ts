// Agent delivery tests cover command result delivery to reply payloads and CLI dependencies.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { deliverAgentCommandResult } from "../agents/command/delivery.js";
import type { ReplyPayload } from "../auto-reply/types.js";
import type { CliDeps } from "../cli/deps.js";
import type { OpenClawConfig } from "../config/config.js";
import type { SessionEntry } from "../config/sessions.js";
import type { RuntimeEnv } from "../runtime.js";
import { normalizeSessionDeliveryState } from "../utils/delivery-context.shared.js";
import type { DeliveryContext } from "../utils/delivery-context.types.js";

const mocks = vi.hoisted(() => ({
  deliverOutboundPayloads: vi.fn(async () => []),
  getChannelPlugin: vi.fn(() => ({ outbound: { deliveryMode: "gateway" } })),
  resolveOutboundTarget: vi.fn(() => ({ ok: true as const, to: "+15551234567" })),
}));

type DeliveryCall = {
  accountId?: string;
  session?: {
    agentId?: string;
    key?: string;
  };
};

type ResolveTargetCall = {
  accountId?: string;
  channel?: string;
  mode?: string;
  to?: string;
};

function readDeliveryCall(): DeliveryCall {
  expect(mocks.deliverOutboundPayloads).toHaveBeenCalledOnce();
  const calls = mocks.deliverOutboundPayloads.mock.calls as unknown as Array<[unknown]>;
  const call = calls[0]?.[0];
  if (!call) {
    throw new Error("Expected delivery call");
  }
  return call as DeliveryCall;
}

function readResolveTargetCall(): ResolveTargetCall {
  expect(mocks.resolveOutboundTarget).toHaveBeenCalledOnce();
  const calls = mocks.resolveOutboundTarget.mock.calls as unknown as Array<[unknown]>;
  const call = calls[0]?.[0];
  if (!call) {
    throw new Error("Expected resolve target call");
  }
  return call as ResolveTargetCall;
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

  function createRuntime(): RuntimeEnv {
    return {
      log: vi.fn(),
      error: vi.fn(),
    } as unknown as RuntimeEnv;
  }

  function createResult(text = "hi") {
    return {
      payloads: [{ text }],
      meta: { durationMs: 1 },
    };
  }

  async function runDelivery(params: {
    opts: Record<string, unknown>;
    outboundSession?: { key?: string; agentId?: string };
    sessionEntry?: SessionEntry;
    runtime?: RuntimeEnv;
    resultText?: string;
    payloads?: ReplyPayload[];
  }) {
    const cfg = {} as OpenClawConfig;
    const deps = {} as CliDeps;
    const runtime = params.runtime ?? createRuntime();
    const result = params.payloads
      ? {
          payloads: params.payloads,
          meta: { durationMs: 1 },
        }
      : createResult(params.resultText);

    await deliverAgentCommandResult({
      cfg,
      deps,
      runtime,
      opts: params.opts as never,
      outboundSession: params.outboundSession,
      sessionEntry: params.sessionEntry,
      result,
      payloads: result.payloads,
    });

    return { runtime };
  }

  beforeEach(() => {
    mocks.deliverOutboundPayloads.mockClear();
    mocks.resolveOutboundTarget.mockClear();
  });

  it("stays silent for intentional empty payloads", async () => {
    const runtime = createRuntime();

    await runDelivery({
      opts: {
        message: "hello",
      },
      runtime,
      payloads: [],
    });

    expect(runtime.log).not.toHaveBeenCalled();
    expect(mocks.deliverOutboundPayloads).not.toHaveBeenCalled();
  });

  it("uses runContext turn source over stale session last route", async () => {
    await runDelivery({
      opts: {
        message: "hello",
        deliver: true,
        runContext: {
          messageChannel: "whatsapp",
          currentChannelId: "+15559876543",
          accountId: "work",
        },
      },
      sessionEntry: sessionEntry({ channel: "slack", to: "U_WRONG", accountId: "wrong" }),
    });

    const targetCall = readResolveTargetCall();
    expect(targetCall.channel).toBe("whatsapp");
    expect(targetCall.to).toBe("+15559876543");
    expect(targetCall.accountId).toBe("work");
  });

  it("does not reuse session lastTo when runContext source omits currentChannelId", async () => {
    await runDelivery({
      opts: {
        message: "hello",
        deliver: true,
        runContext: {
          messageChannel: "whatsapp",
        },
      },
      sessionEntry: sessionEntry({ channel: "slack", to: "U_WRONG" }),
    });

    const targetCall = readResolveTargetCall();
    expect(targetCall.channel).toBe("whatsapp");
    expect(targetCall.to).toBeUndefined();
  });

  it("uses caller-provided outbound session context when opts.sessionKey is absent", async () => {
    await runDelivery({
      opts: {
        message: "hello",
        deliver: true,
        channel: "whatsapp",
        to: "+15551234567",
      },
      outboundSession: {
        key: "agent:exec:hook:gmail:thread-1",
        agentId: "exec",
      },
    });

    const deliveryCall = readDeliveryCall();
    expect(deliveryCall.session?.key).toBe("agent:exec:hook:gmail:thread-1");
    expect(deliveryCall.session?.agentId).toBe("exec");
  });

  it("prefixes per-session nested lanes with the same nested log context (#67502)", async () => {
    const runtime = createRuntime();
    await runDelivery({
      runtime,
      resultText: "Child finished",
      opts: {
        message: "hello",
        deliver: false,
        lane: "nested:agent:ebao-next:quietchat:channel:1",
        sessionKey: "agent:ebao-next:quietchat:channel:1",
        runId: "run-announce",
        messageChannel: "webchat",
      },
      sessionEntry: undefined,
    });

    expect(runtime.log).toHaveBeenCalledTimes(1);
    expect((runtime.log as ReturnType<typeof vi.fn>).mock.calls).toEqual([
      [
        "[agent:nested] session=agent:ebao-next:quietchat:channel:1 run=run-announce channel=webchat Child finished",
      ],
    ]);
  });
});
