import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

type GatewayMethod = (options: {
  params?: { callId?: unknown };
  respond: (ok: boolean, result?: unknown, error?: unknown) => void;
}) => Promise<void>;

type FixturePlugin = {
  register(
    api: {
      registerGatewayMethod(method: string, handler: GatewayMethod): void;
      registerRealtimeVoiceProvider(provider: unknown): void;
    },
    sendReceipt: (source: string, line: string) => void,
  ): void;
};

const runtimeCoordinatorKey = Symbol.for("openclaw.voice-call.runtimeCoordinator");
const unavailableError = {
  code: "UNAVAILABLE",
  message: "Voice Call runtime stream issuer unavailable",
};
const fixtureUrl = pathToFileURL(
  path.resolve("test/e2e/qa-lab/runtime/fixtures/voice-call-runtime-plugin/index.js"),
).href;
const { default: fixturePlugin } = (await import(fixtureUrl)) as { default: FixturePlugin };

function setRuntimeCoordinator(coordinator: unknown): void {
  (globalThis as Record<PropertyKey, unknown>)[runtimeCoordinatorKey] = coordinator;
}

function registerStreamSessionMethod(): GatewayMethod {
  const methods = new Map<string, GatewayMethod>();
  fixturePlugin.register(
    {
      registerGatewayMethod(method, handler) {
        methods.set(method, handler);
      },
      registerRealtimeVoiceProvider() {},
    },
    () => {
      throw new Error("Stream-session issuance must not submit a realtime tool result");
    },
  );
  const streamSessionMethod = methods.get("qa.voiceCall.streamSession");
  if (!streamSessionMethod) {
    throw new Error("Voice Call fixture did not register qa.voiceCall.streamSession");
  }
  return streamSessionMethod;
}

async function expectUnavailable(streamSessionMethod: GatewayMethod): Promise<void> {
  const respond = vi.fn();
  await streamSessionMethod({ params: { callId: "call-123" }, respond });
  expect(respond).toHaveBeenCalledExactlyOnceWith(false, undefined, unavailableError);
}

const clearCoordinator = () => {
  delete (globalThis as Record<PropertyKey, unknown>)[runtimeCoordinatorKey];
};
beforeEach(clearCoordinator);

afterEach(() => {
  clearCoordinator();
  vi.restoreAllMocks();
});

it.each(["absent", "starting", "stopping", "stale"] as const)(
  "returns unavailable for %s runtime",
  async (state) => {
    const owner = {};
    const getCall = vi.fn();
    const streamSessionIssuer = vi.fn();
    if (state !== "absent") {
      setRuntimeCoordinator({
        current: { generation: owner },
        slot:
          state === "stale"
            ? {
                state: "running",
                owner: {},
                runtime: { manager: { getCall, streamSessionIssuer } },
              }
            : { state, owner, promise: Promise.resolve() },
      });
    }
    await expectUnavailable(registerStreamSessionMethod());
    expect(getCall).not.toHaveBeenCalled();
    expect(streamSessionIssuer).not.toHaveBeenCalled();
  },
);

it("issues a stream session from the current running generation", async () => {
  const callId = "call-123";
  const owner = {};
  const call = {
    providerCallId: "provider-call-456",
    from: "+15550000001",
    to: "+15550000002",
    direction: "outbound",
  };
  const getCall = vi.fn(() => call);
  const session = {
    streamUrl: "wss://voice.example.test/stream",
    token: "stream-token",
  };
  const streamSessionIssuer = vi.fn(() => session);
  setRuntimeCoordinator({
    current: { generation: owner },
    slot: {
      state: "running",
      owner,
      runtime: {
        manager: { getCall, streamSessionIssuer },
        webhookUrl: "https://voice.example.test/webhook",
      },
    },
  });
  const respond = vi.fn();

  await registerStreamSessionMethod()({ params: { callId }, respond });

  expect(getCall).toHaveBeenCalledExactlyOnceWith(callId);
  const { providerCallId, ...callDetails } = call;
  expect(streamSessionIssuer).toHaveBeenCalledExactlyOnceWith({
    providerName: "twilio",
    callId,
    ...callDetails,
  });
  expect(respond).toHaveBeenCalledExactlyOnceWith(true, {
    ...session,
    providerCallId,
    webhookUrl: "https://voice.example.test/webhook",
  });
});
