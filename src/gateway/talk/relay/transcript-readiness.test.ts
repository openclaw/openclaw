import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferredCore } from "../../../shared/deferred.js";
import { ensureClientVoiceAgentSessionEntry } from "../../../talk/client-voice-session-write.js";
import { clientVoiceSessionTesting } from "../../../talk/client-voice-session.test-support.js";
import type {
  RealtimeVoiceAgentConsultRunner,
  RealtimeVoiceBridgeCreateRequest,
} from "../../../talk/provider-types.js";
import {
  createOpenClawTestState,
  type OpenClawTestState,
} from "../../../test-utils/openclaw-test-state.js";
import type { TalkAgentConsultLifecycleMethods } from "../client-agent-consult.types.js";
import { controlBridge, controlContext } from "../client-gateway-control.test-support.js";
import { prepareTalkSessionTarget } from "../session-target.js";
import { closeRelaySession } from "./operations.js";
import { createTalkRealtimeRelaySession } from "./session-create.js";
import { relaySessions, type RelaySession } from "./state.js";

const mocks = vi.hoisted(() => ({ run: vi.fn(), steer: vi.fn() }));
// mock-isolation: isolate relay lifecycle from deterministic consult execution.
vi.mock("../client-agent-consult.js", () => ({
  createTalkClientAgentConsultRunner: () => ({
    runPrompt: Object.assign(mocks.run, {
      adoptCompletionClaims: vi.fn(),
      claimAppend: vi.fn(() => true),
      claimFailureAppend: vi.fn(() => true),
      steer: mocks.steer,
    }),
    getToolAuthorityOverlay: vi.fn(),
  }),
}));

describe("native relay transcript readiness", () => {
  let state: OpenClawTestState;
  let relaySessionId: string | undefined;
  let ownedRelay: RelaySession | undefined;
  const connId = "relay-confirmation-client";

  beforeEach(async () => {
    state = await createOpenClawTestState({ label: "relay-confirmation", applyEnv: true });
    await ensureClientVoiceAgentSessionEntry({ agentId: "main", sessionKey: "agent:main:main" });
    mocks.run.mockReset().mockResolvedValue({ text: "Read result." });
    mocks.steer.mockReset().mockResolvedValue({ text: "Read result." });
  });

  afterEach(async () => {
    if (ownedRelay) {
      await closeRelaySession(ownedRelay, "completed");
      ownedRelay = undefined;
    }
    clientVoiceSessionTesting.reset();
    await state.cleanup();
  });

  function createHarness() {
    const cfg = { agents: { entries: { main: { workspace: state.workspaceDir } } } };
    let request: RealtimeVoiceBridgeCreateRequest | undefined;
    const session = createTalkRealtimeRelaySession({
      cfg,
      context: controlContext(),
      connId,
      sessionTarget: prepareTalkSessionTarget(cfg, "agent:main:main"),
      controlSource: "delegation",
      provider: {
        id: "relay-confirmation",
        label: "Relay confirmation",
        isConfigured: () => true,
        createBridge: (options) => {
          request = options;
          return controlBridge();
        },
      },
      providerConfig: {},
      instructions: "Answer briefly.",
      tools: [],
    });
    relaySessionId = session.relaySessionId;
    if (!relaySessionId) {
      throw new Error("expected a relay session id");
    }
    const relay = relaySessions.get(relaySessionId);
    const run: (RealtimeVoiceAgentConsultRunner & TalkAgentConsultLifecycleMethods) | undefined =
      request?.runAgentConsult;
    if (!relay || !request || !run) {
      throw new Error("expected a registered native relay");
    }
    ownedRelay = relay;
    return { request, run, relay };
  }

  it("delegates without waiting for a future spoken confirmation", async () => {
    const h = createHarness();
    h.request.onTranscript?.("user", "Create the", false);
    expect(await h.run({ prompt: "Create the requested note" })).toEqual({ text: "Read result." });
    expect(mocks.run).toHaveBeenCalledOnce();
  });

  it("drains already admitted transcript work before delegating", async () => {
    const h = createHarness();
    const entered = createDeferredCore();
    const release = createDeferredCore();
    h.relay.voiceTranscriptQueue.enqueue(() => {
      entered.resolve();
      return release.promise;
    });
    await entered.promise;
    const run = h.run({ prompt: "Continue the request" });
    expect(mocks.run).not.toHaveBeenCalled();
    release.resolve();
    expect(await run).toEqual({ text: "Read result." });
    expect(mocks.run).toHaveBeenCalledOnce();
  });

  it("cancels a held transcript drain without dispatching", async () => {
    const h = createHarness();
    const release = createDeferredCore();
    h.relay.voiceTranscriptQueue.enqueue(() => release.promise);
    const controller = new AbortController();
    const run = h.run({ prompt: "Continue", signal: controller.signal });
    const rejected = expect(run).rejects.toMatchObject({ name: "AbortError" });
    controller.abort();
    await rejected;
    expect(mocks.run).not.toHaveBeenCalled();
    release.resolve();
    await h.relay.voiceTranscriptQueue.flush();
  });
});
