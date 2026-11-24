import { afterEach, expect, it } from "vitest";
import type { RealtimeVoiceProviderPlugin } from "../../../plugins/types.js";
import type { RealtimeVoiceBridgeCreateRequest } from "../../../talk/provider-contexts.js";
import { resolveRealtimeVoiceProviderCapabilitiesAsync } from "../../../talk/provider-resolver.js";
import { prepareTalkSessionTarget } from "../session-target.js";
import {
  createIdleRelayProvider,
  createRelayEventRecorder,
  makeRelayTransport,
} from "./index.test-support.js";
import { createTalkRealtimeRelaySession } from "./session-create.js";
import { drainingRelaySessions, relaySessions } from "./state.js";

const created: string[] = [];

afterEach(() => {
  for (const relaySessionId of created.splice(0)) {
    relaySessions.delete(relaySessionId);
    drainingRelaySessions.delete(relaySessionId);
  }
});

it("keeps the provider's own error in the Gateway log while the client gets the bounded issue", async () => {
  const error = Object.assign(new Error("upstream rejected the realtime session"), {
    code: "invalid_request_error",
  });
  let captured: RealtimeVoiceBridgeCreateRequest | undefined;
  const provider = createIdleRelayProvider((input) => {
    captured = input;
    return makeRelayTransport();
  }) as RealtimeVoiceProviderPlugin;
  const cfg = { agents: { entries: { main: {} } } } as never;
  const { events, context, warn } = createRelayEventRecorder();
  const capabilities = await resolveRealtimeVoiceProviderCapabilitiesAsync({
    provider,
    providerConfig: {},
    cfg,
    surface: "gateway-relay",
  });
  const session = createTalkRealtimeRelaySession({
    connId: "conn-1",
    provider,
    providerConfig: {},
    instructions: "brief",
    tools: [],
    controlSource: capabilities?.handlesAgentConsult === true ? "delegation" : "transcript",
    capabilities,
    context,
    cfg,
    sessionTarget: await prepareTalkSessionTarget(cfg, "agent:main:main"),
  } as never);
  created.push(session.relaySessionId);

  captured?.onError?.(error);

  expect(warn).toHaveBeenCalledWith(
    expect.stringContaining(
      "Realtime relay provider error during connect: Error invalid_request_error: upstream rejected the realtime session",
    ),
  );
  // The client projection stays bounded: the provider's own text never reaches it.
  expect(JSON.stringify(events)).not.toContain("upstream rejected the realtime session");
});

it("redacts key-like tokens from the logged provider error", async () => {
  const error = new Error("Incorrect API key provided: sk-proj-abcdefghijklmnopqrstuvwxyz012345");
  let captured: RealtimeVoiceBridgeCreateRequest | undefined;
  const provider = createIdleRelayProvider((input) => {
    captured = input;
    return makeRelayTransport();
  }) as RealtimeVoiceProviderPlugin;
  const cfg = { agents: { entries: { main: {} } } } as never;
  const { context, warn } = createRelayEventRecorder();
  const capabilities = await resolveRealtimeVoiceProviderCapabilitiesAsync({
    provider,
    providerConfig: {},
    cfg,
    surface: "gateway-relay",
  });
  const session = createTalkRealtimeRelaySession({
    connId: "conn-1",
    provider,
    providerConfig: {},
    instructions: "brief",
    tools: [],
    controlSource: capabilities?.handlesAgentConsult === true ? "delegation" : "transcript",
    capabilities,
    context,
    cfg,
    sessionTarget: await prepareTalkSessionTarget(cfg, "agent:main:main"),
  } as never);
  created.push(session.relaySessionId);

  captured?.onError?.(error);

  const logged = warn.mock.calls.map(([message]) => String(message)).join("\n");
  expect(logged).toContain("Incorrect API key provided");
  expect(logged).not.toContain("sk-proj-abcdefghijklmnopqrstuvwxyz012345");
});
