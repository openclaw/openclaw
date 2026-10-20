import { beforeEach, describe, expect, it, vi } from "vitest";
import { withinTest } from "../../../test/helpers/promise.js";
import { resolveSessionStorePathCore } from "../../config/sessions/paths.js";
import { withOwnedSessionTranscriptWrites } from "../../config/sessions/transcript-write-context.js";
import {
  getActiveGatewayRootWorkCount,
  getActiveGatewayRootWorkHolders,
  runWithGatewayIndependentRootWorkAdmission,
} from "../../process/gateway-work-admission.js";
import { withSessionTurn } from "../../sessions/session-controller.admission.js";
import { AsyncWorkScope, getAsyncWorkSignal } from "../../shared/async-work-scope.js";
import { createDeferredCore } from "../../shared/deferred.js";
import { mirrorDeliveredPayloads } from "./deliver-transcript.js";

const mocks = vi.hoisted(() => ({
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

async function mirrorInto(sessionKey: string, deferToSessionLane = false): Promise<void> {
  await mirrorDeliveredPayloads({
    delivery: {
      cfg: {},
      channel: "discord",
      to: "1497965766035640391",
      payloads: [],
      mirror: { agentId: "wolf", sessionKey, deferToSessionLane },
    },
    payloads: [{ text: "delivered to the user", mediaUrls: [] }],
  });
}

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
  return mocks.appendAssistantMessageToSessionTranscript.mock.calls[0]?.[0];
}

describe("outbound delivery mirror writer fence", () => {
  beforeEach(() => {
    mocks.appendAssistantMessageToSessionTranscript.mockClear();
    mocks.appendAssistantMessageToSessionTranscript.mockResolvedValue({ ok: true } as const);
  });

  it("carries the running run's fence when it mirrors into that run's own session", async () => {
    await withRunningSession(() => mirrorInto(RUNNING_SESSION_KEY));

    expect(appendedArgs()).toMatchObject({
      sessionKey: RUNNING_SESSION_KEY,
      expectedWriterRunId: "run-running",
      expectedLifecycleRevision: "rev-7",
    });
  });

  it("withholds that fence when it mirrors into a different session", async () => {
    await withRunningSession(() => mirrorInto(OTHER_SESSION_KEY));

    const args = appendedArgs();
    expect(args).toMatchObject({ sessionKey: OTHER_SESSION_KEY });
    // The sender's claim would reject this cross-session mirror as "session rebound".
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
    const target = {
      sessionKey: RUNNING_SESSION_KEY,
      sessionId: "running-requester",
      agentId: "wolf",
      storePath: resolveSessionStorePathCore(undefined, { agentId: "wolf" }),
    };
    const entered = createDeferredCore();
    const release = createDeferredCore();
    const turn = withSessionTurn(target, async () => {
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
      await vi.waitFor(() =>
        expect(mocks.appendAssistantMessageToSessionTranscript).toHaveBeenCalledOnce(),
      );
      expect(appendSignals).toEqual([undefined]);
      expect(appendedArgs()).not.toHaveProperty("expectedWriterRunId");
      await vi.waitFor(() => expect(getActiveGatewayRootWorkCount()).toBe(0));
    } finally {
      release.resolve();
      await Promise.allSettled([turn]);
    }
  });
});
