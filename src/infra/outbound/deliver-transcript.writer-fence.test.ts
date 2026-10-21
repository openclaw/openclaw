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

const { append } = vi.hoisted(() => ({
  append: vi.fn(async (_params: Record<string, unknown>) => ({ ok: true }) as const),
}));

vi.mock("../../config/sessions/transcript.runtime.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../config/sessions/transcript.runtime.js")>()),
  appendAssistantMessageToSessionTranscript: append,
}));

const RUNNING_SESSION_KEY = "agent:wolf:discord:channel:1497965766035640391";
const OTHER_SESSION_KEY = "agent:arthur:discord:channel:1538510183024689305";
const fence = { expectedWriterRunId: "run-running", expectedLifecycleRevision: "rev-7" };

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
        ...fence,
      },
      withTranscriptWrite: async (operation) => await operation(),
    },
    run,
  );
}

describe("outbound delivery mirror writer fence", () => {
  beforeEach(() => {
    append.mockClear().mockResolvedValue({ ok: true } as const);
  });

  it.each([
    { sessionKey: RUNNING_SESSION_KEY, owned: true },
    { sessionKey: OTHER_SESSION_KEY, owned: true },
    { sessionKey: RUNNING_SESSION_KEY, owned: false },
  ])("fences $sessionKey (owned: $owned)", async ({ sessionKey, owned }) => {
    const mirror = () => mirrorInto(sessionKey);
    await (owned ? withRunningSession(mirror) : mirror());
    const args = append.mock.calls[0]?.[0];
    expect(args).toMatchObject({ sessionKey });
    if (owned && sessionKey === RUNNING_SESSION_KEY) {
      expect(args).toMatchObject(fence);
    } else {
      expect(args).not.toHaveProperty("expectedWriterRunId");
      expect(args).not.toHaveProperty("expectedLifecycleRevision");
    }
  });

  it("retains shutdown custody, not the sender's scope or writer", async ({ signal }) => {
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
    append.mockImplementation(async () => {
      appendSignals.push(getAsyncWorkSignal());
      return { ok: true } as const;
    });
    try {
      await withinTest(entered.promise, signal);
      const mirror = () => mirrorInto(RUNNING_SESSION_KEY, true);
      const independent = () =>
        runWithGatewayIndependentRootWorkAdmission(mirror, "direct-delivery");
      await withinTest(
        withRunningSession(() => work.track(independent)),
        signal,
      );
      await work.drain();
      expect(getActiveGatewayRootWorkHolders()).toEqual(["direct-delivery"]);
      expect(append).not.toHaveBeenCalled();
      release.resolve();
      await withinTest(turn, signal);
      await vi.waitFor(() => expect(append).toHaveBeenCalledOnce());
      expect(appendSignals).toEqual([undefined]);
      expect(append.mock.calls[0]?.[0]).not.toHaveProperty("expectedWriterRunId");
      await vi.waitFor(() => expect(getActiveGatewayRootWorkCount()).toBe(0));
    } finally {
      release.resolve();
      await Promise.allSettled([turn]);
    }
  });
});
