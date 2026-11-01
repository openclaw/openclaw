import { beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferredCore } from "../../../shared/deferred.js";
import type {
  RealtimeVoiceAgentConsultRunner,
  RealtimeVoiceBridgeCreateRequest,
} from "../../../talk/provider-types.js";
import { controlBridge, controlContext } from "../client-gateway-control.test-support.js";
import { useRelayFixtures } from "./fixture.test-support.js";
import { createIdleRelayProvider } from "./index.test-support.js";
import type { RelaySession } from "./state.js";

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
  const createRelay = useRelayFixtures();
  let request: RealtimeVoiceBridgeCreateRequest;
  let runConsult: RealtimeVoiceAgentConsultRunner;
  let queue: RelaySession["voiceTranscriptQueue"];

  beforeEach(async () => {
    mocks.run.mockReset().mockResolvedValue({ text: "Read result." });
    mocks.steer.mockReset().mockResolvedValue({ text: "Read result." });
    const createBridge = vi.fn((_request: RealtimeVoiceBridgeCreateRequest) => controlBridge());
    const { relay } = await createRelay({
      context: controlContext(),
      connId: "relay-confirmation-client",
      controlSource: "delegation",
      provider: createIdleRelayProvider(createBridge),
    });
    const captured = createBridge.mock.calls[0]?.[0];
    const run = captured?.runAgentConsult;
    if (!relay || !captured || !run) {
      throw new Error("expected a registered native relay");
    }
    request = captured;
    runConsult = run;
    queue = relay.voiceTranscriptQueue;
  });

  it("delegates without waiting for a future spoken confirmation", async () => {
    request.onTranscript?.("user", "Create the", false);
    expect(await runConsult({ prompt: "Create the requested note" })).toEqual({
      text: "Read result.",
    });
    expect(mocks.run).toHaveBeenCalledOnce();
  });

  it("drains already admitted transcript work before delegating", async () => {
    const entered = createDeferredCore();
    const release = createDeferredCore();
    queue.enqueue(() => {
      entered.resolve();
      return release.promise;
    });
    await entered.promise;
    const run = runConsult({ prompt: "Continue the request" });
    expect(mocks.run).not.toHaveBeenCalled();
    release.resolve();
    expect(await run).toEqual({ text: "Read result." });
    expect(mocks.run).toHaveBeenCalledOnce();
  });

  it("cancels a held transcript drain without dispatching", async () => {
    const release = createDeferredCore();
    queue.enqueue(() => release.promise);
    const controller = new AbortController();
    const run = runConsult({ prompt: "Continue", signal: controller.signal });
    const rejected = expect(run).rejects.toMatchObject({ name: "AbortError" });
    controller.abort();
    await rejected;
    expect(mocks.run).not.toHaveBeenCalled();
    release.resolve();
    await queue.flush();
  });
});
