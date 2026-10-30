import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, expect, it, vi } from "vitest";

type GatewayMethod = (options: {
  params?: { callId?: unknown };
  respond: (ok: boolean, result?: unknown, error?: unknown) => void;
}) => Promise<void>;
type FixtureApi = {
  registerGatewayMethod(method: string, handler: GatewayMethod): void;
  registerRealtimeVoiceProvider(provider: unknown): void;
};
type FixturePlugin = {
  register(api: FixtureApi, sendReceipt: (source: string, line: string) => void): void;
};
const fixtureUrl = pathToFileURL(
  path.resolve("test/e2e/qa-lab/runtime/fixtures/voice-call-runtime-plugin/index.js"),
).href;
const { default: fixturePlugin } = (await import(fixtureUrl)) as { default: FixturePlugin };
const coordinatorKey = Symbol.for("openclaw.voice-call.runtimeCoordinator");
const callId = "call-123";
const call = {
  providerCallId: "provider-call-456",
  from: "+15550000001",
  to: "+15550000002",
  direction: "outbound",
};
const session = { streamUrl: "wss://voice.example.test/stream", token: "stream-token" };
const webhookUrl = "https://voice.example.test/webhook";
const globals = globalThis as Record<PropertyKey, unknown>;
afterEach(() => {
  delete globals[coordinatorKey];
  vi.restoreAllMocks();
});

function fixture(state: "absent" | "unregistered" | "running") {
  const getCall = vi.fn(() => call);
  const streamSessionIssuer = vi.fn(() => session);
  const ensureRuntime = vi.fn(async () => ({
    manager: { getCall, streamSessionIssuer },
    webhookUrl,
  }));
  const respond = vi.fn();
  delete globals[coordinatorKey];
  if (state !== "absent") {
    globals[coordinatorKey] = {
      current: state === "running" ? { ensureRuntime } : undefined,
    };
  }
  let method: GatewayMethod | undefined;
  fixturePlugin.register(
    {
      registerGatewayMethod(name, handler) {
        if (name === "qa.voiceCall.streamSession") {
          method = handler;
        }
      },
      registerRealtimeVoiceProvider() {},
    },
    () => {
      throw new Error("Stream-session issuance must not submit a realtime tool result");
    },
  );
  if (!method) {
    throw new Error("Voice Call fixture did not register qa.voiceCall.streamSession");
  }
  const invoke = method;
  return {
    ensureRuntime,
    getCall,
    streamSessionIssuer,
    respond,
    run: () => invoke({ params: { callId }, respond }),
  };
}

it.each(["absent", "unregistered"] as const)(
  "returns unavailable for %s runtime",
  async (state) => {
    const proof = fixture(state);
    await proof.run();
    expect(proof.respond).toHaveBeenCalledExactlyOnceWith(false, undefined, {
      code: "UNAVAILABLE",
      message: "Voice Call runtime stream issuer unavailable",
    });
    expect(proof.getCall).not.toHaveBeenCalled();
    expect(proof.streamSessionIssuer).not.toHaveBeenCalled();
    expect(proof.ensureRuntime).not.toHaveBeenCalled();
  },
);

it("issues a stream session from the current runtime registration", async () => {
  const proof = fixture("running");
  await proof.run();
  expect(proof.ensureRuntime).toHaveBeenCalledExactlyOnceWith();
  expect(proof.getCall).toHaveBeenCalledExactlyOnceWith(callId);
  const { providerCallId, ...callDetails } = call;
  expect(proof.streamSessionIssuer).toHaveBeenCalledExactlyOnceWith({
    providerName: "twilio",
    callId,
    ...callDetails,
  });
  expect(proof.respond).toHaveBeenCalledExactlyOnceWith(true, {
    ...session,
    providerCallId,
    webhookUrl,
  });
});
