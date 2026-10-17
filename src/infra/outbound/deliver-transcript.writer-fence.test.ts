// Mirror fence tests cover which session's writer claim a delivery mirror carries.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { withinTest } from "../../../test/helpers/promise.js";
import { resolveSessionLane } from "../../agents/embedded-agent-runner/lanes.js";
import { withOwnedSessionTranscriptWrites } from "../../config/sessions/transcript-write-context.js";
import { appendAssistantMessageToSessionTranscript } from "../../config/sessions/transcript.runtime.js";
import { enqueueCommandInLane } from "../../process/command-queue.js";
import {
  getActiveGatewayRootWorkCount,
  getActiveGatewayRootWorkHolders,
  runWithGatewayIndependentRootWorkAdmission,
} from "../../process/gateway-work-admission.js";
import { AsyncWorkScope, getAsyncWorkSignal } from "../../shared/async-work-scope.js";
import { createDeferredCore } from "../../shared/deferred.js";
import { mirrorDeliveredPayloads } from "./deliver-transcript.js";
import type { NormalizedOutboundPayload } from "./payloads.js";

const mocks = vi.hoisted(() => ({
  // Typed with the append params so the recorded call is inspectable without a cast.
  appendAssistantMessageToSessionTranscript: vi.fn(
    async (_params: Record<string, unknown>) => ({ ok: true }) as const,
  ),
}));

vi.mock("../../config/sessions/transcript.runtime.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../config/sessions/transcript.runtime.js")>()),
  appendAssistantMessageToSessionTranscript: mocks.appendAssistantMessageToSessionTranscript,
}));

const RUNNING_SESSION_KEY = "agent:wolf:discord:channel:1497965766035640391";
const OTHER_SESSION_KEY = "agent:arthur:discord:channel:1538510183024689305";

function payload(text: string): NormalizedOutboundPayload {
  return { text, mediaUrls: [] };
}

async function mirrorInto(sessionKey: string, deferToSessionLane = false): Promise<void> {
  await mirrorDeliveredPayloads({
    delivery: {
      cfg: {},
      channel: "discord",
      to: "1497965766035640391",
      payloads: [],
      mirror: { agentId: "wolf", sessionKey, deferToSessionLane },
    },
    payloads: [payload("delivered to the user")],
  });
}

/** Runs a mirror inside a run that owns `RUNNING_SESSION_KEY`, the way a live delivery does. */
async function withRunningSession(run: () => Promise<void>): Promise<void> {
  await withOwnedSessionTranscriptWrites(
    {
      sessionKey: RUNNING_SESSION_KEY,
      sessionTarget: {
        agentId: "wolf",
        sessionKey: RUNNING_SESSION_KEY,
        storePath: "/state/agents/wolf/openclaw-agent.sqlite",
        expectedLifecycleRevision: "rev-7",
        expectedWriterRunId: "run-running",
      },
      withTranscriptWrite: async (operation) => await operation(),
    },
    run,
  );
}

function appendedArgs() {
  return vi.mocked(appendAssistantMessageToSessionTranscript).mock.calls[0]?.[0];
}

describe("outbound delivery mirror writer fence", () => {
  beforeEach(() => {
    mocks.appendAssistantMessageToSessionTranscript.mockClear();
    mocks.appendAssistantMessageToSessionTranscript.mockResolvedValue({ ok: true } as const);
  });

  it("carries the running run's fence when it mirrors into that run's own session", async () => {
    await withRunningSession(async () => {
      await mirrorInto(RUNNING_SESSION_KEY);
    });

    expect(appendedArgs()).toMatchObject({
      sessionKey: RUNNING_SESSION_KEY,
      expectedWriterRunId: "run-running",
      expectedLifecycleRevision: "rev-7",
    });
  });

  it("withholds that fence when it mirrors into a different session", async () => {
    await withRunningSession(async () => {
      await mirrorInto(OTHER_SESSION_KEY);
    });

    const args = appendedArgs();
    expect(args).toMatchObject({ sessionKey: OTHER_SESSION_KEY });
    // A claim about the delivering session is not a claim about this one. Passing it made
    // the transcript guards refuse the append as "session rebound", and the refusal is
    // warn-only after a successful channel send, so the mirror was lost for good.
    expect(args).not.toHaveProperty("expectedWriterRunId");
    expect(args).not.toHaveProperty("expectedLifecycleRevision");
  });

  it("mirrors unfenced when no run owns a transcript write", async () => {
    await mirrorInto(RUNNING_SESSION_KEY);

    const args = appendedArgs();
    expect(args).toMatchObject({ sessionKey: RUNNING_SESSION_KEY });
    expect(args).not.toHaveProperty("expectedWriterRunId");
  });

  it("retains shutdown custody without retaining the sender's scope or writer", async ({
    signal,
  }) => {
    const lane = resolveSessionLane(RUNNING_SESSION_KEY);
    const entered = createDeferredCore();
    const release = createDeferredCore();
    const turn = enqueueCommandInLane(lane, async () => {
      entered.resolve();
      await release.promise;
    });
    const work = new AsyncWorkScope();
    const appendSignals: Array<AbortSignal | undefined> = [];
    mocks.appendAssistantMessageToSessionTranscript.mockImplementation(async () => {
      appendSignals.push(getAsyncWorkSignal());
      return { ok: true } as const;
    });
    try {
      await withinTest(entered.promise, signal);
      await withinTest(
        withRunningSession(() =>
          work.track(() =>
            runWithGatewayIndependentRootWorkAdmission(
              () => mirrorInto(RUNNING_SESSION_KEY, true),
              "direct-delivery",
            ),
          ),
        ),
        signal,
      );
      await work.drain();
      expect(getActiveGatewayRootWorkHolders()).toEqual(["direct-delivery"]);
      expect(mocks.appendAssistantMessageToSessionTranscript).not.toHaveBeenCalled();
      release.resolve();
      await withinTest(turn, signal);
      await withinTest(
        enqueueCommandInLane(lane, async () => {}),
        signal,
      );
      expect(appendSignals).toEqual([undefined]);
      expect(appendedArgs()).not.toHaveProperty("expectedWriterRunId");
      await vi.waitFor(() => expect(getActiveGatewayRootWorkCount()).toBe(0));
    } finally {
      release.resolve();
      await Promise.allSettled([turn, enqueueCommandInLane(lane, async () => {})]);
    }
  });
});
