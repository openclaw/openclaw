import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  createAgentRunDirectAbortError,
  createAgentRunRestartAbortError,
  isAgentRunRestartAbortReason,
  resolveAgentRunAbortLifecycleFields,
} from "../../agents/run-termination.js";
import { GatewayDrainingError } from "../../process/gateway-work-admission.js";
import { deriveGatewaySessionLifecycleSnapshot } from "../session-lifecycle-state.js";

const { beginSessionWorkAdmission } = vi.hoisted(() => ({
  beginSessionWorkAdmission: vi.fn(),
}));

vi.mock("../../sessions/session-lifecycle-admission.js", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../../sessions/session-lifecycle-admission.js")>();
  return { ...actual, beginSessionWorkAdmission };
});

const { createAgentAdmissionController } = await import("./agent-admission-controller.js");

type CapturedInterrupt = (reason?: Error) => unknown;

const SESSION_KEY = "agent:main:main";
const SESSION_ID = "session-main";
const RUN_ID = "run-main";

async function admitController() {
  const chatAbortControllers = new Map<string, { registrationCleanupRequested?: boolean }>();
  const controller = createAgentAdmissionController({
    cfg: {} as never,
    runId: RUN_ID,
    lifecycleGeneration: "generation-1",
    agentDedupeKeys: ["dedupe-key"],
    context: {
      chatAbortControllers,
      dedupe: new Map(),
    } as never,
    io: { emitAcceptance: vi.fn(), emitFinal: vi.fn() } as never,
    dedupeLifecycle: {
      reservationId: "reservation-1",
      abortForLifecycleRotation: vi.fn(() => false),
      markAccepted: vi.fn(),
    } as never,
    getRequestedSessionKey: () => SESSION_KEY,
    getResolvedSessionKey: () => SESSION_KEY,
    getResolvedSessionId: () => SESSION_ID,
    getResolvedSessionAgentId: () => "main",
    getAgentId: () => "main",
    getCfgForAgent: () => undefined,
    getSessionPersisted: () => true,
    getSupersededSessionId: () => undefined,
    setAdmittedSessionId: vi.fn(),
  });
  await controller.acquire("store-path");
  const call = beginSessionWorkAdmission.mock.calls.at(-1)?.[0] as
    | { onInterrupt?: CapturedInterrupt }
    | undefined;
  const onInterrupt = call?.onInterrupt;
  if (!onInterrupt) {
    throw new Error("admission did not register an interrupt handler");
  }
  const abortController = new AbortController();
  const entry = { registrationCleanupRequested: false } as {
    registrationCleanupRequested: boolean;
    abortStopReason?: string;
  };
  chatAbortControllers.set(RUN_ID, entry);
  controller.setAdmittedRunAbort({
    controller: abortController,
    entry,
  } as never);
  return { abortController, entry, onInterrupt };
}

describe("gateway agent-turn admission interrupt disposition", () => {
  beforeEach(() => {
    beginSessionWorkAdmission.mockReset();
    beginSessionWorkAdmission.mockImplementation(async () => ({
      release: vi.fn(),
      interrupted: undefined,
    }));
  });

  it.each([
    {
      name: "direct abort",
      reason: () => createAgentRunDirectAbortError(),
      restartDisposition: false,
    },
    {
      // Session work admission defaults a missing interrupt reason to a plain
      // untyped Error. A queued message taking `run-now`, a session reset, a
      // rollover drain and a hot-reload teardown all arrive that way. None of
      // them is a gateway restart.
      name: "untyped lifecycle interruption",
      reason: () => undefined,
      restartDisposition: false,
    },
    {
      name: "explicit restart abort",
      reason: () => createAgentRunRestartAbortError(),
      restartDisposition: true,
    },
    {
      name: "gateway drain",
      reason: () => new GatewayDrainingError("gateway is draining for restart"),
      restartDisposition: true,
    },
  ])(
    "records a $name interruption with its own disposition",
    async ({ reason, restartDisposition }) => {
      const { abortController, entry, onInterrupt } = await admitController();
      onInterrupt(reason());
      expect(abortController.signal.aborted).toBe(true);
      expect(isAgentRunRestartAbortReason(abortController.signal.reason)).toBe(restartDisposition);
      expect(entry.abortStopReason).toBe(restartDisposition ? "restart" : "rpc");
      // The disposition is what the durable row inherits. Only stopReason
      // "restart" keeps status "running" and sets abortedLastRun, which is the
      // exact pair main-session restart recovery admits on.
      const lifecycle = resolveAgentRunAbortLifecycleFields(abortController.signal);
      expect(lifecycle.stopReason).toBe(restartDisposition ? "restart" : "aborted");
      expect(
        deriveGatewaySessionLifecycleSnapshot({
          session: { status: "running", startedAt: 1_000, updatedAt: 1_000 },
          event: {
            ts: 2_000,
            sessionId: SESSION_ID,
            data: { phase: "end", endedAt: 1_800, ...lifecycle },
          },
        }),
      ).toMatchObject(
        restartDisposition
          ? { status: "running", abortedLastRun: true }
          : { status: "killed", abortedLastRun: true },
      );
    },
  );

  it("keeps an already-aborted admission on its original reason", async () => {
    const { abortController, onInterrupt } = await admitController();
    abortController.abort(createAgentRunDirectAbortError());
    expect(onInterrupt(undefined)).toBeUndefined();
    expect(isAgentRunRestartAbortReason(abortController.signal.reason)).toBe(false);
  });
});
