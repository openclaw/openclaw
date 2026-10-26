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

function fixture(state: "absent" | "starting" | "stopping" | "stale" | "running") {
  const owner = {};
  const getCall = vi.fn(() => call);
  const streamSessionIssuer = vi.fn(() => session);
  const respond = vi.fn();
  delete globals[coordinatorKey];
  if (state !== "absent") {
    globals[coordinatorKey] = {
      current: { generation: owner },
      slot:
        state === "stale" || state === "running"
          ? {
              state: "running",
              owner: state === "stale" ? {} : owner,
              runtime: { manager: { getCall, streamSessionIssuer }, webhookUrl },
            }
          : { state, owner, promise: Promise.resolve() },
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
    getCall,
    streamSessionIssuer,
    respond,
    run: () => invoke({ params: { callId }, respond }),
  };
}

it.each(["absent", "starting", "stopping", "stale"] as const)(
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
  },
);

it("issues a stream session from the current running generation", async () => {
  const proof = fixture("running");
  await proof.run();
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
